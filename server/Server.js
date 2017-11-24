const isEmpty = require("lodash.isempty");
const Users = require("./Users");
const jsondiffpatch = require("../lib/diffpatch");
const COMMANDS = require("../lib/commands");
const deepCopy = require("../lib/deepCopy");


class Server {

    constructor(adapter, transport, diffOptions = {}) {
        if (adapter == null || transport == null) {
            throw new Error("Need to specify an adapter and a transport");
        }

        this.adapter = adapter;
        this.transport = transport;
        this.data = {};
        this.requests = {};
        this.saveRequests = {};
        this.saveQueue = {};

        this.users = new Users(transport);

        // bind functions
        this.trackConnection = this.trackConnection.bind(this);

        this.jsondiffpatch = jsondiffpatch.create(diffOptions);
        this.transport.on("connection", this.trackConnection);
    }


    /**
     * Registers the correct event listeners on the client connection
     * @param  {Socket} connection  - The connection that should get tracked
     */
    trackConnection(connection) {
        connection.on(COMMANDS.join, (room, initializeClient) =>
            this.joinConnection(connection, room, initializeClient)
        );
        connection.on(COMMANDS.syncWithServer, (editMessage, sendClient) =>
            this.receiveEdit(connection, editMessage, sendClient)
        );
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
                    connection.emit(COMMANDS.error, "Need to re-connect!");
                    return;
                }

                // when the versions match, remove old edits stack
                if (editMessage.serverVersion === clientDoc.shadow.serverVersion) {
                    clientDoc.edits = [];
                }

                // if there are no edits, abort
                if (editMessage.edits.length === 0) {
                    return;
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

                // notify all sockets about the update, if not empty
                this.transport.to(editMessage.room).emit(COMMANDS.remoteUpdateIncoming, connection.id);
                this.sendServerChanges(doc, clientDoc, sendToClient);

                // 4) save a snapshot of the document
                return this.saveSnapshot(editMessage.room)
            },
            (error) => {
                connection.emit(COMMANDS.error, "Need to re-connect!");
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
            // schedule a new save request, when after the current job is finished
            if (!this.saveQueue[room]) {
                this.saveQueue[room] = this.saveRequests[room].then(() => this.saveSnapshot(room));
            }
            return this.saveQueue[room];
        }

        const resetSaveSnapshotQueue = () => {
            this.saveRequests[room] = false;
            this.saveQueue[room] = false;
        }

        // flag that we are currently saving data
        this.saveRequests[room] = this.getData(room)
            .then((data) => {
                if (data == false) {
                    return resetSaveSnapshotQueue();
                }
                return this.adapter
                    .storeData(room, data.serverCopy)
                    .then(resetSaveSnapshotQueue)
            })
            .catch((error) => {
                console.log(`Failed saving snapshot of room ${id}`, error.message);
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
        this.getData(room)
            .then((data) => {
                if (data === false) {
                    return;
                }

                // connect to the room
                connection.join(room);

                // track users per room
                this.users.addUser(connection, room);

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
            })
            .catch((error) => {
                console.log("Failed retrieving data");
                throw error;
            })
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
}


module.exports = Server;
