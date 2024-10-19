const core = require("@actions/core");
const https = require("https");
const fs = require("fs").promises;

// Retrieve input parameters from the GitHub Action context
const jiraBaseUrl = core.getInput("jira_base_url");
const jiraUserEmail = core.getInput("jira_user_email");
const jiraApiToken = core.getInput("jira_api_token");
const jiraProjectKey = core.getInput("jira_project_key");
const issueSummary = core.getInput("issue_summary");
const issueDescription = core.getInput("issue_description");

// Create a base64-encoded string for basic authentication
const auth = Buffer.from(`${jiraUserEmail}:${jiraApiToken}`).toString("base64");

// Function to send an HTTP request to Jira
async function sendHttpRequest(method, path, data) {
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
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
        }
      });
    });

    req.on("error", (error) => {
      core.error(`Request error: ${error.message}`);
      reject(error);
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
      `rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=description`
    );
    return response.issues;
  } catch (error) {
    console.error("Error searching Jira issues:", error.message);
    throw error;
  }
}

async function updateJiraIssue(issueKey, description) {
  try {
    const response = await sendHttpRequest(
      "PUT",
      `rest/api/2/issue/${issueKey}`,
      {
        fields: { description: description },
      }
    );

    if (
      response === "" ||
      (typeof response === "string" && response.trim() === "")
    ) {
      console.log(`Updated Jira issue: ${issueKey}`);
      return true;
    } else if (typeof response === "object") {
      console.log(`Updated Jira issue: ${issueKey}`, JSON.stringify(response));
      return true;
    } else {
      console.log(
        `Updated Jira issue: ${issueKey}. Unexpected response:`,
        response
      );
      return true;
    }
  } catch (error) {
    console.error("Error updating Jira issue:", error.message);
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
      `rest/agile/1.0/board/97/sprint?state=future`
    );
    const sprint = response.values.find((s) => s.name === sprintName);
    if (sprint) {
      return sprint.id;
    } else {
      throw new Error(`Sprint "${sprintName}" not found`);
    }
  } catch (error) {
    console.error("Error getting sprint ID:", error.message);
    throw error;
  }
}

async function createOrUpdateJiraStory() {
  try {
    // Search for existing issues with the same summary
    const jql = `project = ${jiraProjectKey} AND summary ~ "${issueSummary}" AND status != Done`;
    const existingIssues = await searchJiraIssues(jql);

    const now = new Date();
    const formattedTimestamp = formatDateTimeGerman(now);
    const updatedDescription = `${issueDescription}\n\nZuletzt aktualisiert: ${formattedTimestamp}`;

    // Get the ID of the "Backlog - Ready for planning" sprint
    const sprintId = await getSprintId("Backlog - Ready for planning");

    if (existingIssues.length > 0) {
      const existingIssue = existingIssues[0];
      const existingDescription = existingIssue.fields.description || "";

      // Compare descriptions without timestamps
      if (
        removeTimestamp(existingDescription) !==
        removeTimestamp(issueDescription)
      ) {
        await updateJiraIssue(existingIssue.key, updatedDescription);
        // Add the issue to the sprint
        await sendHttpRequest(
          "POST",
          `rest/agile/1.0/sprint/${sprintId}/issue`,
          { issues: [existingIssue.key] }
        );
        console.log(
          `Existing issue updated and added to sprint: ${sprintName}`
        );
      } else {
        console.log(
          `No changes detected for existing issue: ${existingIssue.key}`
        );
      }
      core.setOutput("issue_key", existingIssue.key);
      return;
    }

    const issueData = {
      fields: {
        project: { key: jiraProjectKey },
        summary: issueSummary,
        description: updatedDescription,
        issuetype: { name: "Story" },
        sprint: sprintId,
      },
    };

    const response = await sendHttpRequest(
      "POST",
      "rest/api/2/issue",
      issueData
    );
    console.log(
      `Created Jira issue: ${response.key} and added to sprint ${sprintName}`
    );
    core.setOutput("issue_key", response.key);
  } catch (error) {
    console.error("Error creating or updating Jira issue:", error.message);
    core.setFailed(`Failed to create or update Jira issue: ${error.message}`);
  }
}

createOrUpdateJiraStory().catch((error) => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
