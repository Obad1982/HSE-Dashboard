// Verify the workflow transition maps + numbering logic in isolation
const INCIDENT = {
  Draft:["Submitted","Cancelled"],
  Submitted:["Under_Review","Returned_for_Correction","Cancelled"],
  Under_Review:["Analysis_in_Progress","Returned_for_Correction","Cancelled"],
  Returned_for_Correction:["Submitted","Cancelled"],
  Analysis_in_Progress:["Pending_HSE_Manager_Approval","Cancelled"],
  Pending_HSE_Manager_Approval:["Approved","Returned_for_Correction","Cancelled"],
  Approved:["Corrective_Actions_in_Progress","Closed","Cancelled"],
  Corrective_Actions_in_Progress:["Pending_Verification","Cancelled"],
  Pending_Verification:["Closed","Corrective_Actions_in_Progress","Cancelled"],
  Closed:["Reopened"], Reopened:["Corrective_Actions_in_Progress","Under_Review","Cancelled"],
  Cancelled:[]
};
const VNM = {
  Draft:["Submitted","Immediate_Action_Required","Cancelled"],
  Immediate_Action_Required:["Submitted","Under_Review","Cancelled"],
  Submitted:["Under_Review","Cancelled"],
  Under_Review:["Action_Assigned","Cancelled"],
  Action_Assigned:["Action_in_Progress","Cancelled"],
  Action_in_Progress:["Pending_Verification","Cancelled"],
  Pending_Verification:["Done","Action_in_Progress","Cancelled"],
  Done:["Closed","Reopened"], Closed:["Reopened"],
  Reopened:["Action_in_Progress","Cancelled"], Cancelled:[]
};
let pass=0,fail=0;
const chk=(n,a,e)=>{ if(JSON.stringify(a)===JSON.stringify(e)){pass++;console.log('  PASS',n);}
  else{fail++;console.log('  FAIL',n,'expected',e,'got',a);} };

console.log('--- reachability: every status reachable from Draft ---');
function reachable(map){
  const seen=new Set(['Draft']); const q=['Draft'];
  while(q.length){ const c=q.shift(); for(const n of (map[c]||[])) if(!seen.has(n)){seen.add(n);q.push(n);} }
  return seen;
}
const ri=reachable(INCIDENT), rv=reachable(VNM);
chk('incident: all statuses reachable', Object.keys(INCIDENT).filter(s=>!ri.has(s)), []);
chk('vnm: all statuses reachable', Object.keys(VNM).filter(s=>!rv.has(s)), []);

console.log('--- terminal / recovery rules ---');
chk('Cancelled is terminal (incident)', INCIDENT.Cancelled, []);
chk('Cancelled is terminal (vnm)', VNM.Cancelled, []);
chk('Closed can reopen (incident)', INCIDENT.Closed.includes('Reopened'), true);
chk('Closed can reopen (vnm)', VNM.Closed.includes('Reopened'), true);
chk('Done != Closed in vnm (distinct states)', VNM.Done.includes('Closed'), true);

console.log('--- illegal jumps rejected ---');
const can=(m,f,t)=> (m[f]||[]).includes(t);
chk('Draft -> Closed blocked', can(INCIDENT,'Draft','Closed'), false);
chk('Draft -> Approved blocked', can(INCIDENT,'Draft','Approved'), false);
chk('Cancelled -> anything blocked', can(INCIDENT,'Cancelled','Submitted'), false);
chk('Submitted -> Closed blocked', can(VNM,'Submitted','Closed'), false);

console.log('--- report numbering ---');
function nextNum(prefix, year, lastNumber){
  const seq = lastNumber ? parseInt(lastNumber.split('-')[2],10) : 0;
  return `${prefix}-${year}-${String(seq+1).padStart(4,'0')}`;
}
chk('first incident', nextNum('INC',2026,null), 'INC-2026-0001');
chk('increments', nextNum('INC',2026,'INC-2026-0001'), 'INC-2026-0002');
chk('pads to 4', nextNum('NM',2026,'NM-2026-0099'), 'NM-2026-0100');
chk('rolls past 999', nextNum('VIO',2026,'VIO-2026-0999'), 'VIO-2026-1000');
chk('year isolated', nextNum('INC',2027,null), 'INC-2027-0001');
// desc string sort must find the true max
const nums=['INC-2026-0001','INC-2026-0009','INC-2026-0010','INC-2026-0002'];
chk('desc sort finds highest', nums.slice().sort().reverse()[0], 'INC-2026-0010');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
