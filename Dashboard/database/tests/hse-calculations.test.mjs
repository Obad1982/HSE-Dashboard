import {daysBetween, isFAC, isLTI, computeInjurySeverity, allocateLostWorkdays,
        classifyIncident, calculateASR, calculateAFR, getRating,
        DEFAULT_ASR_BANDS, DEFAULT_AFR_BANDS, resolvePeriod, suggestDueDate} from './calc.mjs';

const D = (s) => new Date(s + 'T00:00:00Z');
let pass=0, fail=0;
function chk(name, actual, expected){
  const a=JSON.stringify(actual), e=JSON.stringify(expected);
  if(a===e){pass++; console.log(`  PASS ${name}`);}
  else {fail++; console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);}
}

console.log('--- daysBetween (Excel DAYS semantics) ---');
chk('2026-01-05 -> 2026-01-09 = 4', daysBetween(D('2026-01-05'), D('2026-01-09')), 4);
chk('same day = 0', daysBetween(D('2026-01-05'), D('2026-01-05')), 0);

console.log('--- FAC / LTI boundaries ---');
chk('0 days = FAC', isFAC('Injury', D('2026-01-05'), D('2026-01-05')), true);
chk('3 days = FAC', isFAC('Injury', D('2026-01-05'), D('2026-01-08')), true);
chk('4 days != FAC', isFAC('Injury', D('2026-01-05'), D('2026-01-09')), false);
chk('4 days = LTI', isLTI('Injury', D('2026-01-05'), D('2026-01-09')), true);
chk('3 days != LTI', isLTI('Injury', D('2026-01-05'), D('2026-01-08')), false);
chk('Violation never FAC', isFAC('Violation', D('2026-01-05'), D('2026-01-05')), false);
chk('Near Miss never LTI', isLTI('Near Miss', D('2026-01-05'), D('2026-01-20')), false);
chk('no return date -> not FAC', isFAC('Injury', D('2026-01-05'), null), false);
chk('no return date -> not LTI', isLTI('Injury', D('2026-01-05'), null), false);

console.log('--- severity thresholds (4-15 / 16-45 / >=46) ---');
chk('3d = FAC', computeInjurySeverity('Injury', D('2026-01-05'), D('2026-01-08')), 'FAC');
chk('4d = Minor', computeInjurySeverity('Injury', D('2026-01-05'), D('2026-01-09')), 'Minor');
chk('15d = Minor', computeInjurySeverity('Injury', D('2026-01-05'), D('2026-01-20')), 'Minor');
chk('16d = Moderate', computeInjurySeverity('Injury', D('2026-01-05'), D('2026-01-21')), 'Moderate');
chk('45d = Moderate', computeInjurySeverity('Injury', D('2026-01-01'), D('2026-02-15')), 'Moderate');
chk('46d = Major', computeInjurySeverity('Injury', D('2026-01-01'), D('2026-02-16')), 'Major');
chk('fatality flag wins', computeInjurySeverity('Injury', D('2026-01-01'), D('2026-01-02'), true), 'Fatality');

console.log('--- LWD allocation (unbounded, must sum to total) ---');
const a1 = allocateLostWorkdays('Injury', D('2026-01-28'), D('2026-03-05'));
chk('Jan28->Mar05 spans 3 months', a1, [{year:2026,month:1,lostWorkdays:4},{year:2026,month:2,lostWorkdays:28},{year:2026,month:3,lostWorkdays:4}]);
chk('sums to DAYS()', a1.reduce((s,x)=>s+x.lostWorkdays,0), daysBetween(D('2026-01-28'), D('2026-03-05')));

const a2 = allocateLostWorkdays('Injury', D('2026-01-05'), D('2026-01-09'));
chk('single month', a2, [{year:2026,month:1,lostWorkdays:4}]);

// 5+ months, crossing a year boundary — impossible in the legacy 4-column Excel
const a3 = allocateLostWorkdays('Injury', D('2026-11-20'), D('2027-04-10'));
const tot3 = daysBetween(D('2026-11-20'), D('2027-04-10'));
chk('Nov2026->Apr2027 = 6 monthly rows', a3.length, 6);
chk('crosses year boundary correctly', a3.map(x=>`${x.year}-${x.month}`), ['2026-11','2026-12','2027-1','2027-2','2027-3','2027-4']);
chk('5+ month total preserved (no 4-month cap)', a3.reduce((s,x)=>s+x.lostWorkdays,0), tot3);

// leap year check
const a4 = allocateLostWorkdays('Injury', D('2028-02-01'), D('2028-03-01'));
chk('Feb 2028 leap = 29 days', a4, [{year:2028,month:2,lostWorkdays:29}]);

chk('FAC produces no allocation', allocateLostWorkdays('Injury', D('2026-01-05'), D('2026-01-07')), []);

console.log('--- classifyIncident integration ---');
const c = classifyIncident({source:'Injury', incidentDate:D('2026-01-28'), returnToWorkDate:D('2026-03-05')});
chk('LTI true', c.lti, true);
chk('FAC false', c.fac, false);
chk('total = 36', c.totalLostWorkdays, 36);
chk('severity Moderate', c.severity, 'Moderate');

console.log('--- ASR / AFR ---');
// Jan 2026: 3200 workers * 31 days * 8 hrs = 793600 hrs
const twh = 3200*31*8;
chk('TWH Jan', twh, 793600);
chk('ASR 238 LWDs', Math.round(calculateASR(238, twh)*10000)/10000, Math.round((238*200000/twh)*10000)/10000);
chk('AFR 30 LTIs', Math.round(calculateAFR(30, twh)*10000)/10000, Math.round((30*200000/twh)*10000)/10000);
chk('div-by-zero safe', calculateASR(10, 0), null);

console.log('--- rating bands ---');
chk('ASR 4 = Excellent', getRating(4, DEFAULT_ASR_BANDS), 'Excellent');
chk('ASR 4.1 = Very Good', getRating(4.1, DEFAULT_ASR_BANDS), 'Very Good');
chk('ASR 31 = Poor', getRating(31, DEFAULT_ASR_BANDS), 'Poor');
chk('ASR 99 = Poor (above axis)', getRating(99, DEFAULT_ASR_BANDS), 'Poor');
chk('AFR 0.2 = Excellent', getRating(0.2, DEFAULT_AFR_BANDS), 'Excellent');
chk('AFR 1.3 = Moderate', getRating(1.3, DEFAULT_AFR_BANDS), 'Moderate');

console.log('--- period resolution ---');
chk('H1', resolvePeriod('H1'), {startMonth:1,endMonth:6});
chk('Q3', resolvePeriod('Q3'), {startMonth:7,endMonth:9});
chk('YTD', resolvePeriod('YTD'), {startMonth:1,endMonth:12});
chk('Jun', resolvePeriod('Jun'), {startMonth:6,endMonth:6});

console.log('--- due date suggestion ---');
chk('High Risk = +1d', suggestDueDate('High_Risk', D('2026-06-10')).toISOString().slice(0,10), '2026-06-11');
chk('Moderate = +7d', suggestDueDate('Moderate_Risk', D('2026-06-10')).toISOString().slice(0,10), '2026-06-17');
chk('Very High = same day', suggestDueDate('Very_High_Risk', D('2026-06-10')).toISOString().slice(0,10), '2026-06-10');
chk('Low Risk = null', suggestDueDate('Low_Risk', D('2026-06-10')), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
