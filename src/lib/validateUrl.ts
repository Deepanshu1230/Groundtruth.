import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";

const UrlSchema = z.string().trim().url();

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"; 0.0.0.0 reaches localhost on many systems
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT, often internal infrastructure
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, includes cloud metadata (169.254.169.254)
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, includes 255.255.255.255 broadcast
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("fc00::", 7, "ipv6"); // unique-local, the IPv6 equivalent of 10/8 and 192.168/16
// No rule needed for IPv4-mapped addresses (::ffff:127.0.0.1): BlockList checks them against the IPv4 rules above.

export interface ValidatedUrl {
  url: URL;
  /** The resolved IP the caller should connect to, so DNS can't change between check and use. */
  address: string;
  family: 4 | 6;
}

export async function validateUrl(input: string): Promise<ValidatedUrl> {
  const parsed = UrlSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid URL: ${input}`);

  const url = new URL(parsed.data);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`URL protocol not allowed: ${url.protocol} (only http and https)`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // IPv6 literals keep their brackets in URL.hostname
  if (!hostname) throw new Error(`URL has no hostname: ${input}`);

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);

  // Reject if *any* record is private, otherwise the connection could land on the bad one.
  for (const { address } of addresses) {
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (blocked.check(address, type)) {
      throw new Error(`URL resolves to a private or reserved address: ${hostname} -> ${address}`);
    }
  }

  const { address, family } = addresses[0];
  return { url, address, family: family === 6 ? 6 : 4 };
}
