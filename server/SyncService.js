const isEmpty = require("lodash.isempty");
const EventEmitter = require("events").EventEmitter;
const jsondiffpatch = require("../lib/diffpatch");
const deepCopy = require("../lib/deepCopy");
const eventMap = require("../lib/eventMap");


const EVENTS = eventMap({
    USER_JOINED: "user:joined",
    SERVER_SYNC: "server:sync",
    ERROR_INVALID_CONNECTION: "error:invalid-connection"
});


class SyncService extends EventEmitter {

    constructor(adapter, diffOptions = {}) {
        if (adapter == null) {
            throw new Error("Need to specify an adapter and a transport");
        }

        super();

        this.adapter = adapter;
        this.data = {};
        this.requests = {};
        this.saveRequests = {};
        this.saveQueue = {};
        this.closeQueue = {};

        this.jsondiffpatch = jsondiffpatch.create(diffOptions);
    }

    /**
     * @async
     * Gets data for a room from the internal cache or from the adapter
     *
     * @param  {String}   room      - room identifier
     * @return {Promise} resolving with {Object} or {Boolean:false}
     */
    getData(room) {
        if (this.data[room]) {
            return Promise.resolve(this.data[room]);
        }

        const cache = this.data;
        const requests = this.requests;

        // do nothing in the else case because this operation
        // should only happen once
        if (requests[room]) {
            requests[room] = true;
            return Promise.resolve(false);
        }

        // if there is no request for this room
        // ask the adapter for the data
        requests[room] = true;
        return this.adapter.getData(room)
            .then((data) => {
                cache[room] = {
                    registeredSockets: [],
                    clientVersions: {},
                    serverCopy: data
                };
                requests[room] = false;
                return cache[room];
            });
    }

    /**
     * @async
     * Applies the sent edits to the shadow and the server copy, notifies all connected sockets and saves a snapshot
     * @param  {Object} connection   The connection that sent the edits
     * @param  {Object} editMessage  The message containing all edits
     * @param  {Function} sendToClient The callback that sends the server changes back to the client
     * @return {Promise}
     */
    receiveEdit(connection, editMessage, sendToClient) {
        // -1) The algorithm actually says we should use a checksum here, I don"t think that"s necessary
        // 0) get the relevant doc
        return this.getData(editMessage.room)
            .then((doc) => {
                if (doc === false) {
                    return;
                }

                // 0.a) get the client versions
                const clientDoc = doc.clientVersions[connection.id];

                // no client doc could be found, client needs to re-auth
                if (!clientDoc) {
                    this.emit(EVENTS.ERROR_INVALID_CONNECTION, connection, editMessage.room);
                    return;
                }

                // when the versions match, remove old edits stack
                if (editMessage.serverVersion === clientDoc.shadow.serverVersion) {
                    clientDoc.edits = [];
                }

                // 1) iterate over all edits
                editMessage.edits.forEach((edit) => {
                    // 2) check the version numbers
                    if (edit.serverVersion === clientDoc.shadow.serverVersion &&
                        edit.localVersion === clientDoc.shadow.localVersion) {
                        // versions match
                        // backup! TODO: is this the right place to do that?
                        clientDoc.backup.doc = deepCopy(clientDoc.shadow.doc);

                        // 3) patch the shadow
                        // const snapshot = deepCopy(clientDoc.shadow.doc);
                        this.jsondiffpatch.patch(clientDoc.shadow.doc, deepCopy(edit.diff));
                        // clientDoc.shadow.doc = snapshot;

                        // apply the patch to the server"s document
                        // snapshot = deepCopy(doc.serverCopy);
                        this.jsondiffpatch.patch(doc.serverCopy, deepCopy(edit.diff));
                        // doc.serverCopy = snapshot;

                        // 3.a) increase the version number for the shadow if diff not empty
                        if (!isEmpty(edit.diff)) {
                            clientDoc.shadow.localVersion++;
                        }
                    } else {
                        // TODO: implement backup workflow
                        // has a low priority since `packets are not lost` - but don"t quote me on that :P
                        console.log(
                            "error", `patch rejected!! ${edit.serverVersion} -> ${clientDoc.shadow.serverVersion}:
                            ${edit.localVersion}, "->", ${clientDoc.shadow.localVersion}`
                        );
                    }
                });

                // 4) save a snapshot of the document (sends data to adapter)
                this.saveSnapshot(editMessage.room); // async

                // notify all sockets about the update, if not empty
                if (editMessage.edits.length > 0) {
                    // sends a request to each client, to perform a sync request to the server
                    this.emit(EVENTS.SERVER_SYNC, connection, editMessage.room);
                }

                // send possible patches back to client
                this.sendServerChanges(doc, clientDoc, sendToClient);
            },
            (error) => {
                this.emit(EVENTS.ERROR_INVALID_CONNECTION, connection, editMessage.room);
                console.log(`Failed applying update: ${error.message}`);
            });
    }

    /**
     * @async
     * Save a snapshot of the current data via the adapter. Ensures no multiple store-operations are run parallel.
     *
     * @param  {String} room    - room-id
     * @return {Promise}
     */
    saveSnapshot(room) {

        // only start save if no save going on at the moment
        if (this.saveRequests[room] instanceof Promise) {
            // schedule a new save request to the current job
            if (!this.saveQueue[room]) {
                this.saveQueue[room] = this.saveRequests[room].then(() => this.saveSnapshot(room));
            }
            return this.saveQueue[room];
        }

        const resetSaveSnapshotQueue = () => {
            this.saveRequests[room] = false;
            this.saveQueue[room] = false;
        };

        // flag that we are currently saving data
        this.saveRequests[room] = this.getData(room)
            .then((data) => {
                if (data === false) {
                    return resetSaveSnapshotQueue();
                }
                return this.adapter
                    .storeData(room, data.serverCopy)
                    .then(resetSaveSnapshotQueue);
            })
            .catch((error) => {
                console.log(`Failed saving snapshot of room ${room}`, error.message);
                return resetSaveSnapshotQueue();
            });

        return this.saveRequests[room];
    }

    /**
     * Joins a connection to a room and send the initial data
     * @param  {Connection} connection  - client connection
     * @param  {String} room            - room identifier
     * @param  {Function} initializeClient Callback that is being used for initialization of the client
     */
    joinConnection(connection, room, initializeClient) {
        (this.closeQueue[room] ? this.closeQueue[room] : Promise.resolve())
            .then(() => this.getData(room))
            .then((data) => {
                if (data === false) {
                    console.log("abort join, data is invalid", connection.id);
                    return;
                }

                // connect to the room
                connection.join(room);

                // set up the client version for this socket
                // each connection has a backup and a shadow
                // and a set of edits
                data.clientVersions[connection.id] = {
                    backup: {
                        doc: deepCopy(data.serverCopy),
                        serverVersion: 0
                    },
                    shadow: {
                        doc: deepCopy(data.serverCopy),
                        serverVersion: 0,
                        localVersion: 0
                    },
                    edits: []
                };

                // send the current server version
                initializeClient(data.serverCopy);

                // track users per room
                this.emit(EVENTS.USER_JOINED, connection, room);
            })
            .catch((error) => {
                console.log("Failed retrieving data");
                throw error;
            });
    }

    /**
     * call 'send' with changes from server to client
     * @param  {Object} doc       [description]
     * @param  {Object} clientDoc [description]
     * @param  {Function} send      - callback receiving diff
     */
    sendServerChanges(doc, clientDoc, send) {
        // create a diff from the current server version to the client"s shadow
        const diff = this.jsondiffpatch.diff(clientDoc.shadow.doc, doc.serverCopy);
        const basedOnServerVersion = clientDoc.shadow.serverVersion;

        // add the difference to the server"s edit stack
        if (!isEmpty(diff)) {
            clientDoc.edits.push({
                serverVersion: basedOnServerVersion,
                localVersion: clientDoc.shadow.localVersion,
                diff
            });

            // update the server version
            clientDoc.shadow.serverVersion++;

            // apply the patch to the server shadow
            this.jsondiffpatch.patch(clientDoc.shadow.doc, deepCopy(diff));
        }

        // we explicitly want empty diffs to get sent as well
        send({
            localVersion: clientDoc.shadow.localVersion,
            serverVersion: basedOnServerVersion,
            edits: clientDoc.edits
        });
    }

    close(room) {
        this.closeQueue[room] = this.saveSnapshot(room)
            .then(() => {
                delete this.data[room];
                delete this.requests[room];
                delete this.saveRequests[room];
                delete this.saveQueue[room];

                delete this.closeQueue[room];
            })
            .catch((err) => {
                console.log("Failed to close room %s", room);
                throw err;
            });

        return this.closeQueue[room];
    }
}


module.exports = SyncService;
module.exports.EVENTS = EVENTS;
