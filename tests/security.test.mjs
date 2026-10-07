import assert from 'node:assert/strict';
import test from 'node:test';
import { isResultAttachment, randomIndex, shuffled } from '../app/security.ts';

test('attachment cleanup rejects another owner, another result and traversal',()=>{
 const user='10000000-0000-4000-8000-000000000001', result='20000000-0000-4000-8000-000000000001';
 assert.equal(isResultAttachment(`${user}/${result}/123.docx`,user,result),true);
 for(const path of [`other/${result}/123.docx`,`${user}/other/123.docx`,`${user}/${result}/../123.docx`,`${user}/${result}/123.docx/extra`,`${user}/${result}/123.exe`])
   assert.equal(isResultAttachment(path,user,result),false);
});
test('question shuffle preserves every item without modifying input',()=>{
 const input=Object.freeze([1,2,3,4,5]);
 const result=shuffled(input);
 assert.notEqual(result,input);
 assert.deepEqual([...result].sort(),[...input]);
 assert.deepEqual(shuffled([]),[]);
 assert.equal(randomIndex(1),0);
 assert.throws(()=>randomIndex(0));
});
