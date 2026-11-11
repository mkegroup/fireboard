// Cloudflare Email Worker for Fire Ground Board.
// Sends every email that reaches the calls domain to the inbound-email function.
// Set two secrets on the worker (Settings > Variables and Secrets):
//   FN_URL  https://YOUR_PROJECT_REF.supabase.co/functions/v1/inbound-email
//   SECRET  the same value as INBOUND_SECRET in Supabase
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(env.FN_URL, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-inbound-secret": env.SECRET,
        "x-envelope-to": message.to,
        "x-envelope-from": message.from,
      },
      body: raw,
    });
    if (!res.ok) message.setReject(`Fire Ground Board could not take this email (${res.status})`);
  },
};
