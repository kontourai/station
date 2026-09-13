// Browser-only fixture adapters. No remotely selectable production trust path.
export async function openBrowserTrustStore() {
  window.deviceTrustStore =
    await window.deviceTrustApi.openDeviceConnectionTrustStore();
}

export async function deviceTrustOperation({ operation, arguments: args }) {
  return await window.deviceTrustStore[operation](...args);
}

export async function corruptBrowserTrustRecord({ stationId, value }) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('station-device-connection-trust-v1', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('stations', 'readwrite');
      transaction.objectStore('stations').put(value, stationId);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function upgradeBrowserTrustDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('station-device-connection-trust-v1', 2);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

export function refuseBrowserTrustWrites() {
  IDBObjectStore.prototype.put = () => {
    throw new DOMException('fixture storage unavailable', 'QuotaExceededError');
  };
}

export function refuseBrowserTrustStorage() {
  Object.defineProperty(window, 'indexedDB', {
    get() {
      throw new DOMException('fixture storage unavailable', 'SecurityError');
    },
  });
}

export function downgradeBrowserTrustDurability() {
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (names, mode, options) {
    return original.call(
      this,
      names,
      mode,
      mode === 'readwrite' ? { durability: 'relaxed' } : options,
    );
  };
}

export async function fillBrowserTrustStore({ trust, keyId, stationIds }) {
  for (const stationId of stationIds)
    await window.deviceTrustStore.approve({ ...trust, stationId }, null, keyId);
}

export async function prepareBrowserTrustProof(stationId) {
  const record = await window.deviceTrustStore.read(stationId);
  if (record?.status !== 'approved')
    throw new Error('Missing fixture approval');
  const peer = new RTCPeerConnection();
  const responder = new RTCPeerConnection();
  peer.createDataChannel('trust-refusal-test');
  await peer.setLocalDescription(await peer.createOffer());
  await responder.setRemoteDescription(peer.localDescription);
  await responder.setLocalDescription(await responder.createAnswer());
  window.stationConnectionTrust = record.trust;
  window.stationConnectionTrustRecord = record;
  window.stationConnectionTrustStore = window.deviceTrustStore;
  window.stationTransportLab = {
    peer,
    clientNonce: window.deviceTrustNonce(),
    connectionId: crypto.randomUUID(),
    localDescription: peer.localDescription.sdp,
    proofConsumed: false,
    proofInFlight: false,
  };
  const { clientNonce, connectionId, localDescription } =
    window.stationTransportLab;
  const answer = responder.localDescription.sdp;
  responder.close();
  return { clientNonce, connectionId, offer: localDescription, answer };
}
