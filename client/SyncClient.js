const mitt = require("mitt");
const SyncService = require("./SyncService");
const COMMANDS = require("../lib/commands");


const EVENTS = {
    CONNECTED: "client:connected",
    SYNCED: "client:synced",
    ERROR: "client:error"
};


class SyncClient {

    constructor(socket, room = "", diffOptions = {}) {
        if (!socket) {
            throw new Error("No socket specified");
        }

        this.emitter = mitt();
        this.room = room;
        this.socket = socket;

        const syncService = new SyncService(room, diffOptions);
        this.syncService = syncService;

        // Send the the edits to the server and applies potential updates from the server
        this.syncService.on(SyncService.EVENTS.SYNC_EDITS, (editMessage) => {
            socket.emit(COMMANDS.syncWithServer, editMessage, syncService.applyServerEdits);
        });

        // pass through syncService events
        this.syncService.on(SyncService.EVENTS.SYNCED, () => this.emit(EVENTS.SYNCED));
        this.syncService.on(SyncService.EVENTS.ERROR, () => this.emit(EVENTS.ERROR));

        /**
         * Listen to incoming updates from the server
         * @param  {String} fromId id from the socket that initiated the update
         */
        socket.on(COMMANDS.remoteUpdateIncoming, (fromId) => {
            if (fromId == null) {
                throw new Error("Expected an id");
            }

            // only schedule if the update was not initiated by this client
            if (socket.id !== fromId) {
                syncService.schedule();
            }
        });
    }

    /**
     * @async - will not resolve if an error occurs during join-procedure
     * Join client with server, establishing sync-flow
     * @param  {Any} [credentials]  - optional credentials dependencing on available auth method on server
     * @return {Promise} resolves with this instance
     */
    join(credentials = "") {
        return new Promise((resolve) => {
            this.socket.emit(COMMANDS.join, credentials, this.room, (initialVersion) => {
                this.syncService.initialize(initialVersion);
                // notify about established connection
                this.emit(EVENTS.CONNECTED);
                resolve(this);
            });
        });
    }

    getData() {
        return this.syncService.getData();
    }

    sync() {
        this.syncService.schedule();
    }

    on(...args) {
        if (args[0] == null) {
            throw new Error(`Undefined event-type in SyncClient ${args}`);
        }
        this.emitter.on(...args);
    }

    off(...args) { this.emitter.off(...args); }
    emit(...args) { this.emitter.emit(...args); }

    destroy() {
        this.socket.disconnect();
        this.socket.destroy();
        this.emitter = null;
        this.socket = null;
        this.syncService = null;
    }
}


module.exports = SyncClient;
module.exports.EVENTS = EVENTS;
