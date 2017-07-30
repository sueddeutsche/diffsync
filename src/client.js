const isEmpty = require("lodash.isempty");
const EventEmitter = require("events").EventEmitter;
const jsondiffpatch = require("./diffpatch");
const COMMANDS = require("./commands");
const deepCopy = require("./deepCopy");
const methodsToBind = [
    "_onConnected", "syncWithServer", "applyServerEdit", "applyServerEdits", "schedule", "onRemoteUpdate"
];


class Client extends EventEmitter {

    constructor(socket, room = "", diffOptions = {}) {
        super();

        if (!socket) {
            throw new Error("No socket specified");
        }

        this.socket = socket;
        this.room = room;
        this.syncing = false;
        this.initialized = false;
        this.scheduled = false;
        this.doc = {
            localVersion: 0,
            serverVersion: 0,
            shadow: {},
            localCopy: {},
            edits: []
        };

        this.jsondiffpatch = jsondiffpatch.create(diffOptions);

        // let client be an EventEmitter
        EventEmitter.call(this);

        // bind functions
        methodsToBind.forEach((method) => (this[method] = this[method].bind(this)));
    }

    /**
     * Get the data
     * @return {Object} [description]
     */
    getData() {
        return this.doc.localCopy;
    }

    /**
     * Initializes the sync session
     */
    initialize() {
        // connect, join room and initialize
        this.syncing = true;
        this.socket.emit(COMMANDS.join, this.room, this._onConnected);
    }

    /**
     * Sets up the local version and listens to server updates
     * Will notify the `onConnected` callback.
     * @param  {Object} initialVersion The initial version from the server
     */
    _onConnected(initialVersion) {
        // client is not syncing anymore and is initialized
        this.syncing = false;
        this.initialized = true;

        // set up shadow doc, local doc and initial server version
        // IMPORTANT: the shadow needs to be a deep copy of the initial version
        // because otherwise changes to the local object will also result in changes
        // to the shadow object because they are pointing to the same doc
        this.doc.shadow = deepCopy(initialVersion);
        this.doc.localCopy = initialVersion;
        this.doc.serverVersion = 0;

        // listen to incoming updates from the server
        this.socket.on(COMMANDS.remoteUpdateIncoming, this.onRemoteUpdate);

        // notify about established connection
        this.emit("connected");
    }

    /**
     * Handler for remote updates
     * @param  {String} fromId id from the socket that initiated the update
     */
    onRemoteUpdate(fromId) {
        // only schedule if the update was not initiated by this client
        if (this.socket.id !== fromId) {
            this.schedule();
        }
    }

    /**
     * Schedule a sync cycle. This method should be used from the outside to
     * trigger syncs.
     */
    schedule() {
        // do nothing if already scheduled
        if (this.scheduled) {
            return;
        }
        this.scheduled = true;

        // try to sync now
        this.syncWithServer();
    }

    /**
     * Alias function for `sync`
     */
    sync() {
        this.schedule();
    }


    /**
     * Starts a sync cycle. Should not be called from third parties
     * @return {Boolean} success
     */
    syncWithServer() {
        if (this.syncing || !this.initialized) {
            return false;
        }
        if (this.scheduled) {
            this.scheduled = false;
        }

        // initiate syncing cycle
        this.syncing = true;

        // 1) create a diff of local copy and shadow
        const diff = this.createDiff(this.doc.shadow, this.doc.localCopy);
        const basedOnLocalVersion = this.doc.localVersion;

        // 2) add the difference to the local edits stack if the diff is not empty
        if (!isEmpty(diff)) {
            this.doc.edits.push(this.createDiffMessage(diff, basedOnLocalVersion));
            this.doc.localVersion++;
        }

        // 3) create an edit message with all relevant version numbers
        const editMessage = this.createEditMessage(basedOnLocalVersion);

        // 4) apply the patch to the local shadow
        this.applyPatchTo(this.doc.shadow, deepCopy(diff));

        // 5) send the edits to the server
        this.sendEdits(editMessage);

        // yes, we're syncing
        return true;
    }

    /**
     * Returns a diff of the passed documents
     * @param  {Object} docA
     * @param  {Object} docB
     * @return {Diff}      The diff of both documents
     */
    createDiff(docA, docB) {
        return this.jsondiffpatch.diff(docA, docB);
    }

    /**
     * Applies the path to the specified object
     * WARNING: The patch is applied in place!
     * @param  {Object} obj
     * @param  {Diff} patch
     */
    applyPatchTo(obj, patch) {
        this.jsondiffpatch.patch(obj, patch);
    }

    /**
     * Creates a message for the specified diff
     * @param  {Diff} diff          the diff that will be sent
     * @param  {Number} baseVersion the version of which the diff is based
     * @return {Object}             a diff message
     */
    createDiffMessage(diff, baseVersion) {
        return {
            serverVersion: this.doc.serverVersion,
            localVersion: baseVersion,
            diff
        };
    }

    /**
     * Creates a message representing a set of edits
     * An edit message contains all edits since the last sync has happened.
     * @param  {Number} baseVersion The version that these edits are based on
     * @return {Object}             An edit message
     */
    createEditMessage(baseVersion) {
        return {
            room: this.room,
            edits: this.doc.edits,
            localVersion: baseVersion,
            serverVersion: this.doc.serverVersion
        };
    }


    /**
     * Send the the edits to the server and applies potential updates from the server
     * @param {Object} editMessage
     */
    sendEdits(editMessage) {
        this.socket.emit(COMMANDS.syncWithServer, editMessage, this.applyServerEdits);
    }

    /**
     * Applies all edits from the server and notfies about changes
     * @param {Object} serverEdits  - The edits message
     */
    applyServerEdits(serverEdits) {
        if (serverEdits && serverEdits.localVersion === this.doc.localVersion) {
            // 0) delete all previous edits
            this.doc.edits = [];
            // 1) iterate over all edits
            serverEdits.edits.forEach(this.applyServerEdit);
        } else {
            // Rejected patch because localVersions don"t match
            this.emit("error", "REJECTED_PATCH");
        }

        // we are not syncing any more
        this.syncing = false;

        // notify about sync
        this.emit("synced");

        // if a sync has been scheduled, sync again
        if (this.scheduled) {
            this.syncWithServer();
        }
    }

    /**
     * Applies a single edit message to the local copy and the shadow
     * @param  {Object} editMessage
     * @return {Boolean} success
     */
    applyServerEdit(editMessage) {
        // 2) check the version numbers
        if (editMessage.localVersion === this.doc.localVersion &&
            editMessage.serverVersion === this.doc.serverVersion) {

            if (!isEmpty(editMessage.diff)) {
                // versions match
                // 3) patch the shadow
                this.applyPatchTo(this.doc.shadow, editMessage.diff);

                // 4) increase the version number for the shadow if diff not empty
                this.doc.serverVersion++;
                // apply the patch to the local document
                // IMPORTANT: Use a copy of the diff, or newly created objects will be copied by reference!
                this.applyPatchTo(this.doc.localCopy, deepCopy(editMessage.diff));
            }

            return true;
        }

        // TODO: check in the algo paper what should happen in the case of not matching version numbers
        return false;
    }
}

module.exports = Client;
