// routes/convertiq.js — ConvertIQ audit engine.
//
// Positioning note, because it drives every line below:
// A conversion score is a commodity. Five free tools give one away, and none of them
// get paid, because "add social proof" is worthless advice. ConvertIQ is only worth
// money if it does two things no generic tool does:
//
//   1. Judges the page against what ACTUALLY converted in DTC, not best practices.
//   2. Checks the page against THE AD that paid to send the traffic. The biggest leak
//      in DTC is the gap between the promise in the ad and what the page delivers, and
//      nobody audits it because nobody else asks for the ad.
//
// It also never returns a problem without the exact copy that fixes it.

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const db = require('../db/database');
const validateToken = require('../middleware/validateToken');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.CONVERTIQ_MODEL || 'gpt-4o-mini';
const PRODUCT = 'convertiq';

// Free is capped on AUDITS. Operator and Studio are unlimited: an operator who is
// scared to run an audit is an operator who will not renew.
const PLANS = {
  free:     { audits: 3,        adCongruence: false, rewrite: false, competitor: false, whiteLabel: false },
  operator: { audits: Infinity, adCongruence: true,  rewrite: true,  competitor: true,  whiteLabel: false },
  studio:   { audits: Infinity, adCongruence: true,  rewrite: true,  competitor: true,  whiteLabel: true  },
};
const planOf = p => PLANS[p] || PLANS.free;

// The Winner Index, encoded. These are the patterns that repeatedly won in real DTC
// media buying (hair, skin, supplements, apparel), not textbook CRO.
const WINNER_INDEX = `
WHAT ACTUALLY CONVERTS IN DTC (from tested, money-backed creative — treat as ground truth):

OFFER AND RISK
- The winner almost always carries an explicit risk reversal ABOVE the fold. "90-day money back, keep the bottle." Pages without it lose to pages with it, consistently.
- A named, time-bound result beats a feature. "See new growth in 8 weeks" beats "clinically formulated".
- Price anchoring beats a bare price. Show the compare-at, the per-day cost, or the bundle saving.

PROOF
- Specific proof beats volume of proof. One dated before/after with a real name outperforms a wall of 5-star stars.
- UGC-style proof (phone-shot, imperfect) outperforms studio proof on cold traffic.
- Third-party markers (as-seen-in, dermatologist-tested, ingredient sourcing) carry the cold-traffic objection.

THE FOLD
- Cold traffic decides in about 3 seconds. The fold must answer: what is it, who is it for, what changes, why believe you, what does it cost to try.
- A hero that names the PROBLEM outperforms a hero that names the product.
- One primary CTA. A second competing CTA above the fold reliably drops conversion.

FRICTION
- Every extra form field, every "create an account", every surprise at checkout is a leak.
- Shipping cost revealed late is the single most common abandonment cause in DTC.
- Mobile is where the money is. If the CTA is below the fold on a 375px screen, it is broken.

THE AD-TO-PAGE GAP (the leak nobody audits)
- The visitor arrives holding the promise the ad made. If the page does not repeat that promise in the first screen, in the same words, they bounce, and the click is wasted spend.
- Mismatch of MECHANISM (ad sells a peptide, page sells a routine), of OFFER (ad says 50% off, page says 20%), or of AUDIENCE (ad targets postpartum hair loss, page speaks to everyone) all destroy the click.
`;

const SYSTEM = `You are a direct-response CRO operator who has spent real money buying DTC traffic and has the losing tests to prove it. You are not a consultant and you do not speak in best practices.

Rules, absolutely non-negotiable:
- NEVER give generic advice. "Add social proof", "improve your CTA", "make it above the fold" are worthless and you refuse to write them.
- Every leak you name must state the SPECIFIC thing on THIS page that is wrong, why it costs money on cold paid traffic, and the EXACT COPY to replace it with. Write the replacement copy for them. Do not describe it.
- Quantify. Rank leaks by how much revenue they cost, not by how easy they are to fix.
- If the page is good at something, say so briefly and move on. Do not pad.
- Write like a person, not a report generator. No corporate filler.

${WINNER_INDEX}

Return ONLY valid JSON in exactly this shape:
{
  "score": <0-100 integer, honest, most DTC pages are 40-65>,
  "verdict": "<one blunt sentence a founder would repeat to their partner>",
  "breakdown": { "offer": <0-100>, "proof": <0-100>, "fold": <0-100>, "friction": <0-100>, "mobile": <0-100> },
  "leaks": [
    {
      "title": "<short, specific to this page>",
      "severity": "critical" | "major" | "minor",
      "costsYou": "<why this specifically bleeds money on paid traffic>",
      "found": "<the exact text/element you found on the page>",
      "fix": "<the exact replacement copy, ready to paste. Write it.>",
      "winner": "<what the pages that beat them do instead. Be concrete.>"
    }
  ],
  "adCongruence": {
    "checked": <true|false>,
    "score": <0-100>,
    "verdict": "<what the ad promised vs what the page delivers>",
    "gaps": ["<specific broken promise>"]
  },
  "quickWin": "<the single change to make in the next 10 minutes>"
}`;

function buildPrompt({ pageData, ad, brand, metrics }) {
  const p = [];
  p.push('AUDIT THIS PAGE.\n');
  p.push('URL: ' + (pageData.url || 'unknown'));
  p.push('TITLE: ' + (pageData.title || ''));
  if (brand) p.push('BRAND / PRODUCT CONTEXT: ' + brand);
  if (metrics && (metrics.visitors || metrics.aov || metrics.cr)) {
    p.push(`THEIR NUMBERS: ~${metrics.visitors || '?'} visitors/mo, AOV $${metrics.aov || '?'}, current CR ${metrics.cr || '?'}%`);
  }
  p.push('\n--- WHAT IS ON THE PAGE ---');
  p.push('HEADINGS:\n' + (pageData.headings || []).slice(0, 25).join('\n'));
  p.push('\nCTAs:\n' + (pageData.ctas || []).slice(0, 20).join('\n'));
  p.push('\nBODY COPY (truncated):\n' + String(pageData.text || '').slice(0, 6000));
  if (pageData.images) p.push('\nIMAGE ALT TEXT: ' + (pageData.images || []).slice(0, 15).join(' | '));
  if (pageData.forms) p.push('\nFORM FIELDS: ' + (pageData.forms || []).join(', '));
  if (pageData.price) p.push('\nPRICE SIGNALS: ' + pageData.price);

  if (ad && ad.trim()) {
    p.push('\n--- THE AD THAT PAID FOR THIS CLICK ---');
    p.push(ad.trim());
    p.push('\nAudit the AD-TO-PAGE CONGRUENCE. The visitor arrived holding the promise in that ad. Does the first screen of this page repeat that promise, in those words, with that offer, to that audience? Every gap is wasted ad spend. Set adCongruence.checked = true.');
  } else {
    p.push('\nNo ad supplied, so set adCongruence.checked = false and adCongruence.score = 0.');
  }
  return p.join('\n');
}

// Honest money maths. If they give us their numbers we compute the leak from THEIR
// traffic. If they do not, we return null rather than inventing a number, because a
// made-up dollar figure is exactly the kind of thing that gets a tool distrusted.
function estimateLeak(score, metrics) {
  if (!metrics || !metrics.visitors || !metrics.aov) return null;
  const visitors = Number(metrics.visitors);
  const aov = Number(metrics.aov);
  const currentCr = Number(metrics.cr) || 1.5;
  if (!visitors || !aov) return null;

  // A page scoring 85+ is broadly doing the right things. The gap to 85 is the
  // recoverable headroom. Cap the claimed lift at a believable 60% relative.
  const headroom = Math.max(0, 85 - score) / 85;
  const liftPct = Math.min(0.6, headroom * 0.6);
  const recoveredCr = currentCr * (1 + liftPct);
  const extraOrders = visitors * ((recoveredCr - currentCr) / 100);
  return Math.round(extraOrders * aov);
}

router.post('/audit', validateToken, async (req, res) => {
  try {
    const plan = await db.getEntitlement(req.userId, PRODUCT);
    const limits = planOf(plan);

    const used = await db.countAuditsThisMonth(req.userId);
    if (used >= limits.audits) {
      return res.status(403).json({
        error: 'Free plan includes 3 audits a month.',
        code: 'AUDIT_LIMIT_REACHED',
        plan, used, limit: limits.audits,
      });
    }

    const { pageData, ad, brand, metrics } = req.body || {};
    if (!pageData || !pageData.text) {
      return res.status(400).json({ error: 'No page content supplied.', code: 'NO_PAGE_DATA' });
    }

    // Ad congruence is the paid feature. Do not silently run it for free users:
    // tell them what they are missing, by name.
    const adAllowed = limits.adCongruence && ad;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt({ pageData, ad: adAllowed ? ad : null, brand, metrics }) },
      ],
    });

    const result = JSON.parse(completion.choices[0].message.content);

    // Free users see the top leak only. They can see there is money on the floor,
    // and exactly how many more leaks they are not being shown.
    const allLeaks = Array.isArray(result.leaks) ? result.leaks : [];
    result.totalLeaks = allLeaks.length;
    if (!limits.rewrite) {
      result.leaks = allLeaks.slice(0, 1).map(l => ({ ...l, fix: null, winner: null, locked: true }));
      result.lockedLeaks = Math.max(0, allLeaks.length - 1);
    }
    if (ad && !limits.adCongruence) {
      result.adCongruence = { checked: false, locked: true, score: 0,
        verdict: 'Ad-to-page congruence is an Operator feature. It is where most DTC ad spend actually dies.', gaps: [] };
    }

    result.monthlyLeak = estimateLeak(result.score, metrics);
    result.plan = plan;
    result.auditsUsed = used + 1;
    result.auditsLimit = limits.audits === Infinity ? null : limits.audits;

    await db.saveAudit(req.userId, pageData.url || '', result.score || 0, result.monthlyLeak || 0);
    await db.logEvent(req.userId, 'convertiq_audit', {
      url: pageData.url, score: result.score, plan, ad: !!adAllowed,
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    console.error('convertiq/audit', err);
    res.status(500).json({ error: 'Audit failed.', code: 'AUDIT_FAILED' });
  }
});

router.get('/me', validateToken, async (req, res) => {
  const plan = await db.getEntitlement(req.userId, PRODUCT);
  const used = await db.countAuditsThisMonth(req.userId);
  const limits = planOf(plan);
  res.json({
    plan,
    features: { ...limits, audits: limits.audits === Infinity ? null : limits.audits },
    auditsUsed: used,
    history: await db.getAudits(req.userId, 10),
  });
});

module.exports = router;
