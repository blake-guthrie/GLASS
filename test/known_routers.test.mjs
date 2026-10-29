import { test } from 'node:test';
import assert from 'node:assert/strict';
import known from '../src/data/known.js';

test('known bot routers: resolves GMGN, Trojan, and Bloom program IDs', () => {
  assert.equal(known.programs['GMgnVFR8Jb39LoXsEVzb3DvBy3ywCmdmJquHUy1Lrkqb'], 'GMGN');
  assert.equal(known.programs['troyXT7Ty3s2rjJe4bqWaroUrS4Fjd8rbHHNHxcACF4'], 'Trojan');
  assert.equal(known.programs['b1oomGGqPKGD6errbyfbVMBuzSC8WtAAYo8MwNafWW1'], 'Bloom');
  assert.equal(known.programs['BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW'], 'Photon');
});

test('known bot routers: unknown program returns undefined', () => {
  assert.equal(known.programs['11111111111111111111111111111111'], undefined);
  assert.equal(known.programs['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], undefined);
});
