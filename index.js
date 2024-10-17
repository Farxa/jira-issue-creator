const core = require("@actions/core");
const https = require("https");

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
      let responseData = "";
      res.on("data", (chunk) => (responseData += chunk));
      res.on("end", () => {
        core.debug(`Response status: ${res.statusCode}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseData));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
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

async function createJiraStory() {
  try {
    // Split the description into lines
    const descriptionLines = issueDescription.trim().split("\n");

    // Create ADF content
    const adfContent = descriptionLines.map((line) => ({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: line,
        },
      ],
    }));

    const issueData = {
      fields: {
        project: { key: jiraProjectKey },
        summary: issueSummary,
        description: {
          version: 1,
          type: "doc",
          content: adfContent,
        },
        issuetype: { name: "Story" },
        // Note: We are not using sprints in this issue creation process because we are creating an action for a Kanban board.
        // Kanban boards operate on a continuous flow of work, allowing for the management of tasks as they progress
        // through various stages of completion rather than grouping them into time-boxed iterations (sprints).
        // As a result, there is no concept of assigning issues to sprints; instead, we focus on maintaining
        // the flow of work and ensuring tasks are prioritized and completed as they move through the Kanban columns.
      },
    };

    console.log("Issue data being sent:", JSON.stringify(issueData, null, 2));

    const response = await sendHttpRequest(
      "POST",
      "rest/api/2/issue",
      issueData
    );
    console.log(`Created Jira issue: ${response.key}`);
    core.setOutput("issue_key", response.key);
  } catch (error) {
    console.error("Error creating Jira issue:", error.message);
    core.setFailed(`Failed to create Jira issue: ${error.message}`);
  }
}

createJiraStory().catch((error) => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
