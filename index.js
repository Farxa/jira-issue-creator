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

async function getNeedsRefinementSprint(projectKey) {
  try {
    const boards = await sendHttpRequest(
      "GET",
      `rest/agile/1.0/board?projectKeyOrId=${projectKey}`
    );
    if (boards.values.length === 0)
      throw new Error(`No board found for project ${projectKey}`);

    const boardId = boards.values[0].id;
    const sprints = await sendHttpRequest(
      "GET",
      `rest/agile/1.0/board/${boardId}/sprint?state=active,future,closed`
    );

    const needsRefinementSprint = sprints.values.find(
      (sprint) => sprint.name === "Needs refinement"
    );
    if (!needsRefinementSprint)
      throw new Error("'Needs refinement' sprint not found");
    return needsRefinementSprint;
  } catch (error) {
    throw new Error(
      `Failed to find 'Needs refinement' sprint: ${error.message}`
    );
  }
}

async function createJiraStory() {
  try {
    const needsRefinementSprint = await getNeedsRefinementSprint(
      jiraProjectKey
    );

    const issueData = {
      fields: {
        project: { key: jiraProjectKey },
        summary: issueSummary,
        description: issueDescription,
        issuetype: { name: "Story" },
        customfield_10020: [{ id: needsRefinementSprint.id }],
      },
    };

    const response = await sendHttpRequest(
      "POST",
      "rest/api/2/issue",
      issueData
    );
    console.log(
      `Created Jira issue: ${response.key} in sprint: ${needsRefinementSprint.name}`
    );
    core.setOutput("issue_key", response.key);
  } catch (error) {
    console.error("Error creating Jira issue:", error.message);
    core.setFailed(`Failed to create Jira issue: ${error.message}`);
  }
}

createJiraStory().catch((error) => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
