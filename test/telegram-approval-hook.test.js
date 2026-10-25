'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../mcp/telegram-approval-hook');

const shell = (command, tool = 'PowerShell') => classify(tool, { command }, []);

test('asks before commands that change or send something', () => {
  for (const command of [
    "Send-OutlookMail -To 'a@b.com' -Subject x -Body y -Send",
    "Send-OutlookReply -EntryID $id -Body '<p>ok</p>' -ReplyAll -Send",
    'oc apply -k deploy/openshift',
    'kubectl delete pod x -n y',
    'git push origin main',
    'git reset --hard HEAD~1',
    'rm -rf /tmp/x',
    'Remove-Item C:\\temp\\x -Recurse -Force',
    'Remove-ADUser jdoe',
    "ssh admin@a1k 'volume delete -vserver svm1 -volume vol1'",
    "ssh admin@a1k 'snapmirror break -destination-path svm:vol'",
    'Unlock-ADAccount -Identity jdoe',
    'Restart-Computer -ComputerName srv01',
    "Invoke-RestMethod -Uri $u -Method Post -Body $b",
    'curl -X DELETE https://api/x',
  ]) assert.ok(shell(command), command);
});

test('lets reads, drafts and local work through', () => {
  for (const command of [
    'Get-OutlookMail -From Zamir -Count 10',
    "Send-OutlookMail -To 'a@b.com' -Subject x -Body y",
    'oc get pods -A',
    'kubectl describe node w1',
    'git status --short',
    'git diff --stat',
    'rm -f /tmp/one-file.txt',
    "ssh admin@a1k 'volume show -fields size'",
    'Remove-Variable x',
    'Invoke-RestMethod -Uri $u',
    'curl -s https://api/x',
    'node --test test/*.test.js',
  ]) assert.equal(shell(command), null, command);
});

test('asks before MCP tools that write, never for Telegram tools', () => {
  assert.ok(classify('mcp__atlassian__createJiraIssue', { summary: 'x' }, []));
  assert.ok(classify('mcp__claude_ai_Gmail__send_message', { to: 'x' }, []));
  assert.equal(classify('mcp__atlassian__getJiraIssue', { key: 'IG-1' }, []), null);
  assert.equal(classify('mcp__telegram-tg__tg_send', { text: 'hi' }, []), null);
  assert.equal(classify('Read', { file_path: 'x' }, []), null);
});

test('supports extra patterns from agent-runtime.json', () => {
  assert.ok(classify('Bash', { command: 'terraform apply' }, ['\\bterraform\\s+apply\\b']));
});
