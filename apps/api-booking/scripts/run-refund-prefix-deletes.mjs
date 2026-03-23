#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const prefixes = [
  'refund-pay-later-1774211542539-zxi2xw',
  'refund-pay-later-1774212146330-82e3tg',
  'refund-pay-later-1774212328929-z4anc2',
  'refund-pay-later-1774212459416-vzvilr',
  'refund-pay-later-1774212639734-laq0b6',
  'refund-pay-later-1774212749698-i6mu1c',
  'refund-pay-later-1774212810380-i84gmk',
  'refund-pay-later-1774212987415-n6ctu5',
  'refund-pay-later-1774213057430-8guqwx',
  'refund-pay-later-1774213133596-wlfrhc',
  'refund-pay-later-1774213454807-yp66fu',
  'refund-pay-later-1774213560030-tqtrfm',
  'refund-pay-later-1774213727918-ziuimr',
  'refund-pay-later-1774213827704-tm30ak',
  'refund-pay-later-1774213971260-9ast52',
  'refund-pay-later-1774214059062-1qtlvx',
  'refund-pay-later-1774214261385-gkrkbg',
  'refund-pay-later-1774214461179-zr23m1',
  'refund-pay-later-1774214860007-700puc',
  'refund-pay-later-1774214949217-53walu',
  'refund-pay-later-1774215431448-uqtqvx',
  'refund-pay-later-1774215669654-af7bjt',
  'refund-pay-later-1774216958790-gdodcv',
  'refund-pay-later-1774217781691-cqqt6d',
  'refund-pay-later-1774218731670-wfqoxk',
  'refund-pay-later-1774219062877-yyuz6s',
  'refund-pay-later-1774219223013-4h9dmv',
  'refund-pay-later-1774219483270-4xgvb8',
  'refund-pay-later-1774219720584-8396hm',
  'refund-pay-later-1774220129217-5evo0c',
  'refund-pay-later-1774220240749-nmi1lx',
  'refund-pay-later-1774220477900-wskzuz',
  'refund-pay-later-1774271146773-3ww5gn',
  'refund-pay-later-1774272031863-m1ky3b',
  'refund-pay-later-1774278880571-qhkz09',
  'refund-pay-later-1774279630930-wrtqk5',
  'refund-pay-later-1774279902335-3ozm7n',
  'refund-pay-later-1774280136734-gj5qa6',
  'refund-pay-now-1774211503858-vwkbmv',
  'refund-pay-now-1774212107674-v6nzhe',
  'refund-pay-now-1774212290461-51u3xg',
  'refund-pay-now-1774212419613-ove8jr',
  'refund-pay-now-1774212564977-trh6hu',
  'refund-pay-now-1774212677245-0uizhv',
  'refund-pay-now-1774212795963-j7kqnu',
  'refund-pay-now-1774212956026-6xfd1u',
  'refund-pay-now-1774213043524-7izq61',
  'refund-pay-now-1774213100175-b6mvzr',
  'refund-pay-now-1774213437261-o0x21h',
  'refund-pay-now-1774213532227-aaorqi',
  'refund-pay-now-1774213694364-akfqvn',
  'refund-pay-now-1774213789106-ifu0hb',
  'refund-pay-now-1774213929905-2xy2zp',
  'refund-pay-now-1774214042836-nx6ft3',
  'refund-pay-now-1774214251021-040h28',
  'refund-pay-now-1774214435596-re8xbj',
  'refund-pay-now-1774214822008-suxu1b',
  'refund-pay-now-1774214922705-fxjh68',
  'refund-pay-now-1774215404352-zbm8nu',
  'refund-pay-now-1774215645029-ss3t5k',
  'refund-pay-now-1774216931958-zgshfd',
  'refund-pay-now-1774217752759-hcoxny',
  'refund-pay-now-1774218704304-8xt6wm',
  'refund-pay-now-1774219025686-syw9z2',
  'refund-pay-now-1774219185518-z670k5',
  'refund-pay-now-1774219445369-u5lean',
  'refund-pay-now-1774219681977-mg3kvn',
  'refund-pay-now-1774220092226-ssww1a',
  'refund-pay-now-1774220202991-q6cohk',
  'refund-pay-now-1774220440586-fi49b3',
  'refund-pay-now-1774222171783-jxvnnm',
  'refund-pay-now-1774271117561-to7hb4',
  'refund-pay-now-1774272007300-le5je7',
  'refund-pay-now-1774278853123-8chqd2',
  'refund-pay-now-1774279587654-hyrm54',
  'refund-pay-now-1774279848694-04bgw0',
  'refund-pay-now-1774280113966-vfi98q',
];

const totals = {
  contact_messages: 0,
  event_reminder_subscriptions: 0,
  api_logs: 0,
  exception_logs: 0,
  booking_side_effect_attempts: 0,
  booking_side_effects: 0,
  booking_events: 0,
  payments: 0,
  bookings: 0,
  clients: 0,
};

const completed = [];

for (const prefix of prefixes) {
  const raw = execFileSync(
    'node',
    ['./scripts/delete-client-prefix.mjs', `--email-prefix=${prefix}`, '--execute'],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
    },
  );

  const marker = '{\n  "level": "info",\n  "source": "maintenance",\n  "eventType": "client_prefix_purge_cli_summary"';
  const startIndex = raw.lastIndexOf(marker);
  if (startIndex === -1) {
    throw new Error(`Missing summary JSON for ${prefix}`);
  }

  const parsed = JSON.parse(raw.slice(startIndex));
  const counts = parsed.context.deleted_counts;
  for (const [key, value] of Object.entries(counts)) {
    totals[key] += Number(value || 0);
  }
  completed.push({
    prefix,
    deleted_counts: counts,
  });
}

console.log(JSON.stringify({
  prefix_count: prefixes.length,
  totals,
  completed,
}, null, 2));
