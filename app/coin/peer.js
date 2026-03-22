/**
 * PeerJS WebRTC integration for 6502coin social play.
 *
 * Generates a peer ID from the wallet's public key, manages connections,
 * and provides a simple send/receive API over WebRTC data channels.
 *
 * Requires PeerJS loaded via CDN (window.Peer).
 *
 * @module app/coin/peer
 */

/**
 * @typedef {Object} PeerConnection
 * @property {string} peerId - remote peer's ID
 * @property {import('peerjs').DataConnection} conn - PeerJS data connection
 * @property {boolean} open - whether the connection is currently open
 */

/**
 * Manages a PeerJS peer instance and connections.
 */
export class CoinPeer {
  /**
   * @param {string} publicKeyHex - wallet public key (64 hex chars)
   * @param {Object} [options]
   * @param {function(string, Object):void} [options.onMessage] - callback(peerId, data)
   * @param {function(string):void} [options.onConnect] - callback(peerId)
   * @param {function(string):void} [options.onDisconnect] - callback(peerId)
   * @param {function(string):void} [options.onError] - callback(errorMessage)
   */
  constructor(publicKeyHex, options = {}) {
    this.publicKeyHex = publicKeyHex;
    // Use first 8 chars of public key as peer ID prefix, plus a random suffix
    // to allow multiple tabs/sessions from the same wallet
    this.peerId = '6502-' + publicKeyHex.slice(0, 8);
    this.onMessage = options.onMessage ?? (() => {});
    this.onConnect = options.onConnect ?? (() => {});
    this.onDisconnect = options.onDisconnect ?? (() => {});
    this.onError = options.onError ?? (() => {});

    /** @type {Map<string, import('peerjs').DataConnection>} */
    this._connections = new Map();
    /** @type {import('peerjs').Peer|null} */
    this._peer = null;
    this._destroyed = false;
  }

  /**
   * Initialize the PeerJS peer and start listening for connections.
   * @returns {Promise<string>} the assigned peer ID
   */
  async start() {
    if (typeof Peer === 'undefined') {
      throw new Error('PeerJS not loaded. Add the PeerJS CDN script to index.html.');
    }

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line no-undef
      this._peer = new Peer(this.peerId, {
        debug: 0, // minimal logging
      });

      this._peer.on('open', (id) => {
        this.peerId = id; // may differ if collision
        console.log(`[peer] listening as ${id}`);
        resolve(id);
      });

      this._peer.on('connection', (conn) => {
        this._setupConnection(conn);
      });

      this._peer.on('error', (err) => {
        // Handle ID taken by appending random suffix
        if (err.type === 'unavailable-id') {
          const suffix = Math.random().toString(36).slice(2, 6);
          this.peerId = '6502-' + this.publicKeyHex.slice(0, 8) + '-' + suffix;
          this._peer.destroy();
          // eslint-disable-next-line no-undef
          this._peer = new Peer(this.peerId, { debug: 0 });
          this._peer.on('open', (id) => {
            this.peerId = id;
            console.log(`[peer] listening as ${id} (retry)`);
            resolve(id);
          });
          this._peer.on('connection', (conn) => {
            this._setupConnection(conn);
          });
          this._peer.on('error', (e) => {
            console.error('[peer] error:', e);
            this.onError(e.message || String(e));
          });
        } else {
          console.error('[peer] error:', err);
          this.onError(err.message || String(err));
          if (!this._peer?.open) {
            reject(err);
          }
        }
      });

      this._peer.on('disconnected', () => {
        // Try to reconnect to signaling server
        if (!this._destroyed && this._peer) {
          console.log('[peer] disconnected from signaling, reconnecting...');
          this._peer.reconnect();
        }
      });
    });
  }

  /**
   * Connect to a remote peer by ID.
   * @param {string} remotePeerId
   * @returns {Promise<void>}
   */
  connectToPeer(remotePeerId) {
    if (!this._peer) throw new Error('Peer not started. Call start() first.');
    if (this._connections.has(remotePeerId)) {
      console.log(`[peer] already connected to ${remotePeerId}`);
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const conn = this._peer.connect(remotePeerId, {
        reliable: true,
        serialization: 'binary',
      });

      const timeout = setTimeout(() => {
        reject(new Error(`Connection to ${remotePeerId} timed out`));
      }, 10000);

      conn.on('open', () => {
        clearTimeout(timeout);
        this._setupConnection(conn);
        resolve();
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Set up event handlers for a data connection.
   * @param {import('peerjs').DataConnection} conn
   * @private
   */
  _setupConnection(conn) {
    const peerId = conn.peer;
    this._connections.set(peerId, conn);

    conn.on('open', () => {
      console.log(`[peer] connected to ${peerId}`);
      // Send handshake with our public key
      this.send(peerId, {
        type: 'handshake',
        publicKeyHex: this.publicKeyHex,
      });
      this.onConnect(peerId);
    });

    // If already open (outbound connections), fire immediately
    if (conn.open) {
      console.log(`[peer] connected to ${peerId}`);
      this.send(peerId, {
        type: 'handshake',
        publicKeyHex: this.publicKeyHex,
      });
      this.onConnect(peerId);
    }

    conn.on('data', (data) => {
      this.onMessage(peerId, data);
    });

    conn.on('close', () => {
      console.log(`[peer] disconnected from ${peerId}`);
      this._connections.delete(peerId);
      this.onDisconnect(peerId);
    });

    conn.on('error', (err) => {
      console.error(`[peer] connection error with ${peerId}:`, err);
      this._connections.delete(peerId);
      this.onDisconnect(peerId);
    });
  }

  /**
   * Send data to a connected peer.
   * @param {string} peerId
   * @param {Object|ArrayBuffer|Uint8Array} data
   */
  send(peerId, data) {
    const conn = this._connections.get(peerId);
    if (!conn || !conn.open) {
      console.warn(`[peer] cannot send to ${peerId}: not connected`);
      return false;
    }
    conn.send(data);
    return true;
  }

  /**
   * Send data to all connected peers.
   * @param {Object|ArrayBuffer|Uint8Array} data
   */
  broadcast(data) {
    for (const [peerId, conn] of this._connections) {
      if (conn.open) {
        conn.send(data);
      }
    }
  }

  /**
   * Get list of connected peer IDs.
   * @returns {string[]}
   */
  getConnectedPeers() {
    const peers = [];
    for (const [peerId, conn] of this._connections) {
      if (conn.open) peers.push(peerId);
    }
    return peers;
  }

  /**
   * Whether we have any active connections.
   * @returns {boolean}
   */
  isConnected() {
    return this.getConnectedPeers().length > 0;
  }

  /**
   * Disconnect from a specific peer.
   * @param {string} peerId
   */
  disconnect(peerId) {
    const conn = this._connections.get(peerId);
    if (conn) {
      conn.close();
      this._connections.delete(peerId);
    }
  }

  /**
   * Shut down the peer entirely.
   */
  destroy() {
    this._destroyed = true;
    for (const conn of this._connections.values()) {
      conn.close();
    }
    this._connections.clear();
    if (this._peer) {
      this._peer.destroy();
      this._peer = null;
    }
  }
}
