(() => {
  "use strict";

  const PREFIX = "MURPHY1.";
  const ITERATIONS = 600000;
  const MAX_TOKEN_LENGTH = 20000;
  const ADDITIONAL_DATA = new TextEncoder().encode("Murphy Classroom Pass dashboard credentials v1");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function assertSupported() {
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder || !window.TextDecoder) {
      throw new Error("This browser does not support the encryption required by this page. Use a current Firefox, Chrome, or Edge browser over HTTPS or localhost.");
    }
  }

  async function deriveKey(password, salt, iterations, usages) {
    const material = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return window.crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  }

  async function encryptString(plaintext, password) {
    assertSupported();
    if (typeof plaintext !== "string" || !plaintext.length) throw new Error("There is nothing to encrypt.");
    if (typeof password !== "string" || password.length < 12) throw new Error("Use a password with at least 12 characters.");

    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITERATIONS, ["encrypt"]);
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA, tagLength: 128 },
      key,
      encoder.encode(plaintext),
    );
    const envelope = {
      v: 1,
      alg: "AES-256-GCM",
      kdf: "PBKDF2-SHA-256",
      i: ITERATIONS,
      s: bytesToBase64Url(salt),
      n: bytesToBase64Url(iv),
      c: bytesToBase64Url(new Uint8Array(ciphertext)),
    };
    return PREFIX + bytesToBase64Url(encoder.encode(JSON.stringify(envelope)));
  }

  async function decryptString(token, password) {
    assertSupported();
    if (typeof token !== "string" || !token.startsWith(PREFIX) || token.length > MAX_TOKEN_LENGTH) {
      throw new Error("The encrypted string is not a supported Murphy dashboard bundle.");
    }
    if (typeof password !== "string" || !password.length) throw new Error("Enter the password.");

    let envelope;
    try {
      envelope = JSON.parse(decoder.decode(base64UrlToBytes(token.slice(PREFIX.length))));
    } catch {
      throw new Error("The encrypted string is damaged or incomplete.");
    }
    if (
      !envelope || envelope.v !== 1 || envelope.alg !== "AES-256-GCM" ||
      envelope.kdf !== "PBKDF2-SHA-256" || !Number.isInteger(envelope.i) ||
      envelope.i < 100000 || envelope.i > 1000000
    ) {
      throw new Error("The encrypted string uses an unsupported format.");
    }

    try {
      const salt = base64UrlToBytes(envelope.s);
      const iv = base64UrlToBytes(envelope.n);
      const ciphertext = base64UrlToBytes(envelope.c);
      if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) throw new Error("invalid envelope");
      const key = await deriveKey(password, salt, envelope.i, ["decrypt"]);
      const plaintext = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA, tagLength: 128 },
        key,
        ciphertext,
      );
      return decoder.decode(plaintext);
    } catch {
      throw new Error("The password is incorrect, or the encrypted string was changed.");
    }
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  window.MurphyCredentialCrypto = Object.freeze({
    encryptString,
    decryptString,
    isSupported: () => Boolean(window.crypto && window.crypto.subtle),
    formatPrefix: PREFIX,
    iterations: ITERATIONS,
  });
})();
