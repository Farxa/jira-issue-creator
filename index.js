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

async function createOrUpdateJiraStory() {
  try {
    // Search for existing issues with the same summary
    const jql = `project = ${jiraProjectKey} AND summary ~ "${issueSummary}" AND status != Done`;
    const existingIssues = await searchJiraIssues(jql);

    const timestamp = new Date().toISOString();
    const updatedDescription = `${issueDescription}\n\nLast updated: ${timestamp}`;

    if (existingIssues.length > 0) {
      const existingIssue = existingIssues[0];
      const existingDescription = existingIssue.fields.description || "";

      // Compare descriptions without timestamps
      if (
        removeTimestamp(existingDescription) !==
        removeTimestamp(issueDescription)
      ) {
        await updateJiraIssue(existingIssue.key, updatedDescription);
        console.log(
          `Existing issue updated with new information: ${existingIssue.key}`
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
        // Note: We are not using sprints in this issue creation process because we are creating an action for a Kanban board.
        // Kanban boards operate on a continuous flow of work, allowing for the management of tasks as they progress
        // through various stages of completion rather than grouping them into time-boxed iterations (sprints).
        // As a result, there is no concept of assigning issues to sprints; instead, we focus on maintaining
        // the flow of work and ensuring tasks are prioritized and completed as they move through the Kanban columns.
      },
    };

    const response = await sendHttpRequest(
      "POST",
      "rest/api/2/issue",
      issueData
    );
    if (response.rawResponse) {
      console.log(
        `Created Jira issue, but couldn't parse response. Raw response: ${response.rawResponse}`
      );
      core.setOutput("issue_key", response.key);
    } else {
      console.log(`Created Jira issue: ${response.key}`);
      core.setOutput("issue_key", response.key);
    }
  } catch (error) {
    console.error("Error creating or updating Jira issue:", error.message);
    core.setFailed(`Failed to create or update Jira issue: ${error.message}`);
  }
}

createOrUpdateJiraStory().catch((error) => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
