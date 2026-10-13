import assert from 'node:assert/strict';
import test from 'node:test';
import { profileEntry } from '../src/profile-entry.ts';
import type { RemoteProfileStatus } from '../src/remote-autofill.ts';

const empty: RemoteProfileStatus = {
  draftRevision: 0,
  publishedRevision: 0,
  publishedStatus: 'empty',
  hasPendingImport: false,
  hasUnpublishedDraft: false,
  recordOptions: {},
};

test('missing service is not presented as a first-time empty profile', () => {
  const unavailable = profileEntry(null, 404);
  assert.equal(unavailable.action, 'rescan');
  assert.match(unavailable.statusLabel, /尚未上线/);
  assert.doesNotMatch(unavailable.actionLabel, /上传|建立/);
});

test('first-time user is directed to upload or manually create the server profile', () => {
  const firstUse = profileEntry(empty, null);
  assert.equal(firstUse.action, 'edit-profile');
  assert.match(firstUse.actionLabel, /上传简历|手工建立/);
});

test('pending import, unsaved data, and active profiles show distinct next steps', () => {
  const pending = profileEntry({ ...empty, hasPendingImport: true }, null);
  assert.match(pending.actionLabel, /写入/);
  const draft = profileEntry({ ...empty, draftRevision: 1, hasUnpublishedDraft: true }, null);
  assert.match(draft.actionLabel, /保存/);
  const published = profileEntry({ ...empty, publishedRevision: 2, publishedStatus: 'active' }, null);
  assert.match(published.statusLabel, /v2/);
  assert.equal(published.action, 'edit-profile');
});
