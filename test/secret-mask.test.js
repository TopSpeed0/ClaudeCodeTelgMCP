'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maskSecrets } = require('../mcp/secret-mask');

const hidden = (text, secret) => {
  const out = maskSecrets(text);
  assert.ok(!out.includes(secret), `"${secret}" still visible in: ${out}`);
  assert.match(out, /\[REDACTED\]/);
  return out;
};

test('hides PowerShell and CLI secret parameters', () => {
  hidden("Connect-Thing -Server x -Password 'S3cret!' -Force", 'S3cret!');
  hidden('Set-ADAccountPassword jdoe -NewPassword "Pa ss1" -Reset', 'Pa ss1');
  hidden('tool --token=abc123def --verbose', 'abc123def');
  hidden('tool --api-key abc123def', 'abc123def');
  hidden("$pw = ConvertTo-SecureString 'Plain123' -AsPlainText -Force", 'Plain123');
  hidden("$token = 'zzzTOPzzz'; Invoke-X", 'zzzTOPzzz');
});

test('hides headers, URL credentials and JSON fields', () => {
  const out = hidden('curl -H "Authorization: Bearer eyabc.def.ghi123" -X POST https://x', 'eyabc.def.ghi123');
  assert.match(out, /Authorization: Bearer \[REDACTED\]/, 'the scheme stays readable');
  hidden("iwr https://x -Headers @{ 'X-Api-Key' = 'k-999' }", 'k-999');
  hidden('git clone https://bob:hunter2@git.example.com/r.git', 'hunter2');
  hidden('mcp__x__create_user {"name":"a","password":"p@ss\\"w"}', 'p@ss');
  hidden('mcp__x__login {"client_secret":"cs-1","user":"u"}', 'cs-1');
});

test('hides well-known token formats anywhere', () => {
  hidden('echo sk-ant-api03-abcdefghijklmnop', 'sk-ant-api03-abcdefghijklmnop');
  hidden('use ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123');
  hidden('bot 1234567890:AAHmyGODooBaiUUACdoodequCEv1F5FmF3c here', 'AAHmyGODooBaiUUACdoodequCEv1F5FmF3c');
  hidden('key AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP');
});

test('leaves ordinary commands alone', () => {
  for (const text of ['git push origin main', 'Remove-Item C:\\temp\\x -Recurse', 'Get-ADUser -Filter "Name -like \'*pass*\'"', 'volume delete -vserver svm1 -volume vol1',
    'Connect-X -Credential $cred -Password $pw', '$token = $env:GITHUB_TOKEN', 'pwsh -File x.ps1 -PasswordFile C:\\p.txt']) {
    assert.equal(maskSecrets(text), text);
  }
});
