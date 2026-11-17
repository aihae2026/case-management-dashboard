import { isPrivateHost } from "./ssrf.ts";

const blocked = [
  "localhost", "localhost.", "LOCALHOST", "foo.internal.", "x.local", "127.0.0.1", "10.1.2.3",
  "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "198.18.0.1",
  "224.0.0.1", "[::1]", "[::]", "[fe80::1]", "[fe90::1]", "[febf::1]", "[fd12::1]", "[fc00::1]",
  "[::ffff:7f00:1]", "[ff02::1]", "[64:ff9b::1]",
];
const allowed = ["example.com", "fcbarcelona.com", "fdic.gov", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]"];

for (const h of blocked) Deno.test(`차단: ${h}`, () => { if (!isPrivateHost(h)) throw new Error("통과됨"); });
for (const h of allowed) Deno.test(`허용: ${h}`, () => { if (isPrivateHost(h)) throw new Error("차단됨"); });
