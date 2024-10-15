const core = require('@actions/core');
const https = require('https');

// Retrieve input parameters from the GitHub Action context
const jiraBaseUrl = core.getInput('jira_base_url');
const jiraUserEmail = core.getInput('jira_user_email');
const jiraApiToken = core.getInput('jira_api_token');
const jiraProjectKey = core.getInput('jira_project_key');
const sprintName = core.getInput('sprint_name');
const issueSummary = core.getInput('issue_summary');
const issueDescription = core.getInput('issue_description');

// Create a base64-encoded string for basic authentication
const auth = Buffer.from(`${jiraUserEmail}:${jiraApiToken}`).toString('base64');

// Function to send an HTTP request to Jira
async function sendHttpRequest(method, path, data) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: new URL(jiraBaseUrl).hostname,
            path: `/rest/api/2${path}`,
            method: method,
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/json',
            },
        };

        core.debug(`Sending ${method} request to ${options.path}`);

        const req = https.request(options, res => {
            let responseData = '';
            res.on('data', chunk => {
                responseData += chunk;
            });
            res.on('end', () => {
                core.debug(`Response status: ${res.statusCode}`);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(responseData));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
                }
            });
        });

        req.on('error', error => {
            core.error(`Request error: ${error.message}`);
            reject(error);
        });

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

async function findSprintId(sprintName) {
    try {
        const boardId = await findBoardId(jiraProjectKey);
        const sprints = await sendHttpRequest('GET', `/agile/1.0/board/${boardId}/sprint?state=active,future`);
        const sprint = sprints.values.find(s => s.name === sprintName);
        if (!sprint) {
            throw new Error(`Sprint "${sprintName}" not found`);
        }
        return sprint.id;
    } catch (error) {
        throw new Error(`Failed to find sprint ID: ${error.message}`);
    }
}

async function findBoardId(projectKey) {
    try {
        const boards = await sendHttpRequest('GET', `/agile/1.0/board?projectKeyOrId=${projectKey}`);
        if (boards.values.length === 0) {
            throw new Error(`No board found for project ${projectKey}`);
        }
        return boards.values[0].id;
    } catch (error) {
        throw new Error(`Failed to find board ID: ${error.message}`);
    }
}

async function createJiraStory() {
    try {
        const sprintId = await findSprintId(sprintName);

        const issueData = {
            fields: {
                project: {key: jiraProjectKey},
                summary: issueSummary,
                description: issueDescription,
                issuetype: {name: 'Story'},
                // field name for sprint?: sprintId,
            },
        };

        const response = await sendHttpRequest('POST', '/issue', issueData);
        console.log(`Created Jira issue: ${response.key}`);
        core.setOutput('issue_key', response.key);
    } catch (error) {
        console.error('Error creating Jira issue:', error.message);
        core.setFailed(`Failed to create Jira issue: ${error.message}`);
    }
}

createJiraStory().catch(error => {
    core.setFailed(`Unhandled error: ${error.message}`);
});
