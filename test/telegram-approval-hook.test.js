'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../mcp/telegram-approval-hook');

const shell = (command, tool = 'PowerShell') => classify(tool, { command }, []);

test('asks before commands that change or send something', () => {
  for (const command of [
    "Send-OutlookMail -To 'a@b.com' -Subject x -Body y -Send",
    "Send-OutlookReply -EntryID $id -Body '<p>ok</p>' -ReplyAll -Send",
    'oc apply -k deploy/app',
    'kubectl delete pod x -n y',
    'git push origin main',
    'git reset --hard HEAD~1',
    'rm -rf /tmp/x',
    'Remove-Item C:\\temp\\x -Recurse -Force',
    'Remove-ADUser jdoe',
    "ssh admin@filer1 'volume delete -vserver svm1 -volume vol1'",
    "ssh admin@filer1 'snapmirror break -destination-path svm:vol'",
    'Unlock-ADAccount -Identity jdoe',
    'Restart-Computer -ComputerName srv01',
    "Invoke-RestMethod -Uri $u -Method Post -Body $b",
    'curl -X DELETE https://api/x',
  ]) assert.ok(shell(command), command);
});

test('lets reads, drafts and local work through', () => {
  for (const command of [
    'Get-OutlookMail -From Alice -Count 10',
    "Send-OutlookMail -To 'a@b.com' -Subject x -Body y",
    'oc get pods -A',
    'kubectl describe node w1',
    'git status --short',
    'git diff --stat',
    'rm -f /tmp/one-file.txt',
    "ssh admin@filer1 'volume show -fields size'",
    'Remove-Variable x',
    'Invoke-RestMethod -Uri $u',
    'curl -s https://api/x',
    'node --test test/*.test.js',
  ]) assert.equal(shell(command), null, command);
});

test('asks before MCP tools that write, never for Telegram tools', () => {
  assert.ok(classify('mcp__tracker__createIssue', { summary: 'x' }, []));
  assert.ok(classify('mcp__claude_ai_Gmail__send_message', { to: 'x' }, []));
  assert.equal(classify('mcp__tracker__getIssue', { key: 'ABC-1' }, []), null);
  assert.equal(classify('mcp__telegram-tg__tg_send', { text: 'hi' }, []), null);
  assert.equal(classify('Read', { file_path: 'x' }, []), null);
});

test('reads MCP tool names word by word', () => {
  for (const tool of ['mcp__storage__break_mirror', 'mcp__storage__restore_snapshot', 'mcp__storage__resync_mirror',
    'mcp__storage__initialize_mirror', 'mcp__storage__delete_volume', 'mcp__monitor__set_maintenance_mode',
    'mcp__monitor__suite_write', 'mcp__tracker__addCommentToIssue', 'mcp__tracker__transitionIssue']) {
    assert.ok(classify(tool, {}, []), tool);
  }
  for (const tool of ['mcp__cluster__k8s_list_daemonsets', 'mcp__cluster__k8s_list_statefulsets',
    'mcp__netmon__ipam_free_addresses', 'mcp__storage__list_volumes', 'mcp__hypervisor__get_vm',
    'mcp__tracker__getIssue', 'mcp__netmon__recent_events', 'mcp__hypervisor__get_snapshots']) {
    assert.equal(classify(tool, {}, []), null, tool);
  }
});

test('supports extra patterns from agent-runtime.json', () => {
  assert.ok(classify('Bash', { command: 'terraform apply' }, ['\\bterraform\\s+apply\\b']));
});
