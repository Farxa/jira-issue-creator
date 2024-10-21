const core = require("@actions/core");
const https = require("https");
const { Buffer } = require("buffer");

// Input validation
function validateInputs() {
  const requiredInputs = [
    "jira_base_url",
    "jira_user_email",
    "jira_api_token",
    "jira_project_key",
    "issue_summary",
    "issue_description",
    "board_id",
    "sprint_name",
  ];

  for (const input of requiredInputs) {
    if (!core.getInput(input)) {
      throw new Error(`Missing required input: ${input}`);
    }
  }
}

// Retrieve input parameters from the GitHub Action context
const jiraBaseUrl = core.getInput("jira_base_url");
const jiraUserEmail = core.getInput("jira_user_email");
const jiraApiToken = core.getInput("jira_api_token");
const jiraProjectKey = core.getInput("jira_project_key");
const issueSummary = core.getInput("issue_summary");
const issueDescription = core.getInput("issue_description");
const boardId = core.getInput("board_id");
const sprintName = core.getInput("sprint_name");
const retries = parseInt(core.getInput("retry_count")) || 3;

// Create a base64-encoded string for basic authentication
const auth = Buffer.from(`${jiraUserEmail}:${jiraApiToken}`).toString("base64");

// HTTP request function with retry logic and rate limiting
async function sendHttpRequest(method, path, data, retries, delay = 1000) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: new URL(jiraBaseUrl).hostname,
      path: path.startsWith("/") ? path : `/${path}`,
      method: method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    };

    core.debug(`Sending ${method} request to ${options.path}`);

    const req = https.request(options, (res) => {
      let responseData = [];
      res.on("data", (chunk) => responseData.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(responseData).toString();
        core.debug(`Response status: ${res.statusCode}`);
        core.debug(`Raw response: ${responseBody}`);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (responseBody.trim() === "") {
            // Empty response is considered successful for update operations
            resolve("");
          } else {
            try {
              const parsedData = JSON.parse(responseBody);
              resolve(parsedData);
            } catch (error) {
              core.warning(`Failed to parse JSON response: ${error.message}`);
              core.warning(`Raw response: ${responseBody}`);
              // Resolve with the raw response data instead of rejecting
              resolve(responseBody);
            }
          }
        } else if (res.statusCode === 429 && retries > 0) {
          // Rate limiting - retry after delay
          setTimeout(() => {
            sendHttpRequest(method, path, data, retries - 1, delay * 2)
              .then(resolve)
              .catch(reject);
          }, delay);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
        }
      });
    });

    req.on("error", (error) => {
      core.error(`Request error: ${error.message}`);
      if (retries > 0) {
        setTimeout(() => {
          sendHttpRequest(method, path, data, retries - 1, delay * 2)
            .then(resolve)
            .catch(reject);
        }, delay);
      } else {
        reject(error);
      }
    });

    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function searchJiraIssues(jql) {
  try {
    // (Jira Query Language) query to search for issues with the same summary
    const response = await sendHttpRequest(
      "GET",
      `rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=description`,
      null,
      retries
    );
    return response.issues;
  } catch (error) {
    core.error("Error searching Jira issues:", error.message);
    throw error;
  }
}

async function updateJiraIssue(issueKey, description) {
  try {
    await sendHttpRequest(
      "PUT",
      `rest/api/2/issue/${issueKey}`,
      {
        fields: { description: description },
      },
      retries
    );
    core.info(`Updated Jira issue: ${issueKey}`);
    return true;
  } catch (error) {
    core.error("Error updating Jira issue:", error.message);
    throw error;
  }
}

function removeTimestamp(description) {
  return description.replace(/\n\nLast updated: .+$/, "");
}

function formatDateTimeGerman(date) {
  return date.toLocaleString("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

async function getSprintId(sprintName) {
  try {
    const response = await sendHttpRequest(
      "GET",
      `rest/agile/1.0/board/${boardId}/sprint?state=future`
    );
    const sprint = response.values.find((s) => s.name === sprintName);
    if (sprint) {
      return sprint.id;
    } else {
      throw new Error(`Sprint "${sprintName}" not found`);
    }
  } catch (error) {
    core.error("Error getting sprint ID:", error.message);
    throw error;
  }
}

async function getIssueSprintStatus(issueKey) {
  try {
    // First, get all sprints for the board
    const sprintsResponse = await sendHttpRequest(
      "GET",
      `rest/agile/1.0/board/${boardId}/sprint?state=active,future`
    );

    // Then, for each sprint, check if the issue is in it
    for (const sprint of sprintsResponse.values) {
      const issuesInSprintResponse = await sendHttpRequest(
        "GET",
        `rest/agile/1.0/sprint/${sprint.id}/issue?jql=key=${issueKey}`
      );

      if (issuesInSprintResponse.issues.length > 0) {
        return sprint.state; // Return the state of the sprint containing the issue
      }
    }

    return null; // Issue not found in any sprint
  } catch (error) {
    core.error(
      `Error getting sprint status for issue ${issueKey}:`,
      error.message
    );
    throw error;
  }
}

function getNewDescription(existingDescription, newDescription) {
  const existingLines = existingDescription.split("\n");
  const newLines = newDescription.split("\n");
  const newContent = newLines.filter((line) => !existingLines.includes(line));
  return newContent.join("\n");
}

async function createOrUpdateJiraStory() {
  try {
    validateInputs();
    // Search for existing issues with the same summary
    const jql = `project = ${jiraProjectKey} AND summary ~ "${issueSummary}" AND status != Done`;
    const existingIssues = await searchJiraIssues(jql);

    const now = new Date();
    const formattedTimestamp = formatDateTimeGerman(now);

    // Get the ID of the sprint
    const sprintId = await getSprintId(sprintName);

    if (!sprintId) {
      throw new Error(`Sprint "${sprintName}" not found`);
    }

    if (existingIssues.length > 0) {
      const existingIssue = existingIssues[0];
      const existingDescription = existingIssue.fields.description || "";
      const sprintStatus = await getIssueSprintStatus(existingIssue.key);

      if (sprintStatus === "active") {
        // Create a new issue with only the new content
        const newContent = getNewDescription(
          existingDescription,
          issueDescription
        );
        if (newContent.trim() !== "") {
          const newDescription = `${newContent}\n\nZuletzt aktualisiert: ${formattedTimestamp}`;
          const newIssue = await createNewJiraIssue(newDescription, sprintId);
          await addIssueToSprint(newIssue.key, sprintId);
          core.setOutput("issue_key", newIssue.key);
          core.info(
            `Created new issue ${newIssue.key} as existing issue ${existingIssue.key} is in an active sprint`
          );
        } else {
          core.info(
            `No new content to add. Existing issue ${existingIssue.key} remains unchanged.`
          );
          core.setOutput("issue_key", existingIssue.key);
        }
      } else if (sprintStatus === "future" || sprintStatus === null) {
        // Update existing issue
        const updatedDescription = `${issueDescription}\n\nZuletzt aktualisiert: ${formattedTimestamp}`;
        if (
          removeTimestamp(existingDescription) !==
          removeTimestamp(issueDescription)
        ) {
          await updateJiraIssue(existingIssue.key, updatedDescription);
          await addIssueToSprint(existingIssue.key, sprintId);
          core.info(`Updated existing issue: ${existingIssue.key}`);
        } else {
          core.info(
            `No changes detected for existing issue: ${existingIssue.key}`
          );
        }
        core.setOutput("issue_key", existingIssue.key);
      } else {
        core.warning(`Unexpected sprint status: ${sprintStatus}`);
      }
    } else {
      // Create new issue
      const newDescription = `${issueDescription}\n\nZuletzt aktualisiert: ${formattedTimestamp}`;
      const newIssue = await createNewJiraIssue(newDescription, sprintId);
      await addIssueToSprint(newIssue.key, sprintId);
      core.setOutput("issue_key", newIssue.key);
      core.info(`Created new Jira issue: ${newIssue.key}`);
    }
  } catch (error) {
    core.setFailed(`Failed to create or update Jira issue: ${error.message}`);
    throw error;
  }
}

async function createNewJiraIssue(description, sprintId) {
  const issueData = {
    fields: {
      project: { key: jiraProjectKey },
      summary: issueSummary,
      description: description,
      issuetype: { name: "Story" },
    },
  };

  const response = await sendHttpRequest("POST", "rest/api/2/issue", issueData);
  core.info(`Created Jira issue: ${response.key}`);
  return response;
}

async function addIssueToSprint(issueKey, sprintId) {
  await sendHttpRequest("POST", `rest/agile/1.0/sprint/${sprintId}/issue`, {
    issues: [issueKey],
  });
  core.info(`Issue ${issueKey} added to sprint: ${sprintName}`);
}

createOrUpdateJiraStory().catch((error) => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
