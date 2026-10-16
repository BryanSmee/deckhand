// The egress proxy's address checks (proxy/addresses.mjs): what it never connects to, in
// any of the ways an address can be written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedAddress, embeddedV4, v6Bytes } from "../proxy/addresses.mjs";

test("v6Bytes: any spelling of an IPv6 address, as its 16 bytes", () => {
  const loopback = [...Array(15).fill(0), 1];
  assert.deepEqual(v6Bytes("::1"), loopback);
  assert.deepEqual(v6Bytes("0:0:0:0:0:0:0:1"), loopback);
  assert.deepEqual(v6Bytes("::1%eth0"), loopback);
  assert.deepEqual(v6Bytes("::"), Array(16).fill(0));
  assert.deepEqual(v6Bytes("::ffff:10.1.2.3"), [...Array(10).fill(0), 255, 255, 10, 1, 2, 3]);
  assert.deepEqual(
    v6Bytes("2001:db8::ff00:42:8329"),
    [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0xff, 0x00, 0x00, 0x42, 0x83, 0x29],
  );
  for (const bad of ["127.0.0.1", "not-an-ip", "", "1:2:3:4:5:6:7:8:9", "::g"]) {
    assert.equal(v6Bytes(bad), null, bad);
  }
});

test("embeddedV4: the IPv4 address behind mapped, translated, compatible, NAT64 and 6to4", () => {
  const cases = {
    "::ffff:169.254.169.254": "169.254.169.254",
    "::ffff:0:a9fe:a9fe": "169.254.169.254",
    "::7f00:1": "127.0.0.1",
    "::": "0.0.0.0",
    "64:ff9b::a00:1": "10.0.0.1",
    "2002:c0a8:101::1": "192.168.1.1",
  };
  for (const [ip, v4] of Object.entries(cases)) assert.equal(embeddedV4(v6Bytes(ip)), v4, ip);
  for (const ip of ["2001:db8::1", "fd00::1", "64:ff9b:1::a00:1", "::1:0:0:1"]) {
    assert.equal(embeddedV4(v6Bytes(ip)), null, ip);
  }
});

test("blockedAddress: never the host itself, link-local, multicast or benchmarking", () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.53",
    "169.254.169.254",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "198.19.255.255",
    "::1",
    "::",
    "fe80::1",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "::ffff:7f00:1",
    "2002:a9fe:a9fe::",
  ]) {
    assert.equal(blockedAddress(ip, true), true, ip);
  }
});

test("blockedAddress: private ranges only when the host was allowed by name", () => {
  for (const ip of [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "fc00::1",
    "fdff::1",
    "64:ff9b:1::1",
    "::ffff:10.0.0.1",
    "64:ff9b::c0a8:101",
  ]) {
    assert.equal(blockedAddress(ip, false), true, ip);
    assert.equal(blockedAddress(ip, true), false, ip);
  }
});

test("blockedAddress: public addresses go through; the edges of the ranges too", () => {
  for (const ip of [
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700::1111",
    "FE7F::1",
    "64:ff9b::808:808",
  ]) {
    assert.equal(blockedAddress(ip, false), false, ip);
  }
  assert.equal(blockedAddress("example.com", true), true);
});
