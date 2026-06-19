// Generate a VAPID keypair for Web Push. Add the output to your .env.
import { generateVapidKeys } from '../src/notify/channels/webpush.js';

const { publicKey, privateKey } = generateVapidKeys();
console.log('VAPID_PUBLIC_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + privateKey);
console.log('# Also set VAPID_SUBJECT=mailto:you@example.com');
