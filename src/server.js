const isEmpty = require("lodash.isempty");
const jsondiffpatch = require("./diffpatch");
const COMMANDS = require("./commands");
const deepCopy = require("./deepCopy");


class Users {

    constructor(transport) {
        this.transport = transport;
        this.users = {};
    }

    // track users per room
    addUser(connection, room) {
        const user = { id: connection.id };
        this.users[room] = this.users[room] || [];
        this.users[room].push(user);

        // user disconnected
        connection.on("disconnect", () => {
            this.users[room] = this.users[room].filter((user) => user.id !== connection.id);
            console.log(`User disconnected from room ${room}`, this.users[room]);
            this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
        });

        console.log("listen to", COMMANDS.updateUserData);

        // request: update user meta data
        connection.on(COMMANDS.updateUserData, (roomId, meta) => {
            const user = this.getUser(roomId, meta.id);
            if (user) {
                console.log("Update user meta and notify");
                // @todo allow removal of properties
                Object.assign(user, meta);
                this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
            }
        });

        console.log(`User connected to room ${room}`, this.users[room]);
        this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
    }

    getUser(room, id) {
        const users = this.users[room];
        if (users == null || users.length === 0) {
            console.log(`There is no user ${id} in room ${room}`);
            return;
        }
        for (let i = 0; i < users.length; i += 1) {
            if (users[i].id === id) {
                return users[i];
            }
        }
        return;
    }
}


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
        connection.on(COMMANDS.join, this.joinConnection.bind(this, connection));
        connection.on(COMMANDS.syncWithServer, this.receiveEdit.bind(this, connection));
    }

    /**
     * Joins a connection to a room and send the initial data
     * @param  {Connection} connection
     * @param  {String} room             room identifier
     * @param  {Function} initializeClient Callback that is being used for initialization of the client
     */
    joinConnection(connection, room, initializeClient) {
        this.getData(room, (error, data) => {
            if (error) {
                throw new Error(`Failed retrieving data ${error}`);
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
        });
    }


    /**
     * Gets data for a room from the internal cache or from the adapter
     *
     * @param  {String}   room      - room identifier
     * @param  {Function} callback  - notifier-callback
     * @return {undefined}
     */
    getData(room, callback) {
        if (this.data[room]) {
            return callback(null, this.data[room]);
        }

        const cache = this.data;
        const requests = this.requests;

        // do nothing in the else case because this operation
        // should only happen once
        if (requests[room]) {
            requests[room] = true;
            return undefined;
        }

        // if there is no request for this room
        // ask the adapter for the data
        requests[room] = true;
        this.adapter.getData(room, (error, data) => {
            if (error) {
                throw new Error(`Failed retrieving data from adapter ${error}`);
            }

            cache[room] = {
                registeredSockets: [],
                clientVersions: {},
                serverCopy: data
            };

            requests[room] = false;
            return callback(null, cache[room]);
        });

        return undefined;
    }

    /**
     * Applies the sent edits to the shadow and the server copy, notifies all connected sockets and saves a snapshot
     * @param  {Object} connection   The connection that sent the edits
     * @param  {Object} editMessage  The message containing all edits
     * @param  {Function} sendToClient The callback that sends the server changes back to the client
     */
    receiveEdit(connection, editMessage, sendToClient) {
        // -1) The algorithm actually says we should use a checksum here, I don"t think that"s necessary
        // 0) get the relevant doc
        this.getData(editMessage.room, (err, doc) => {
            // 0.a) get the client versions
            const clientDoc = doc.clientVersions[connection.id];

            // no client doc could be found, client needs to re-auth
            if (err || !clientDoc) {
                connection.emit(COMMANDS.error, "Need to re-connect!");
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

            // 4) save a snapshot of the document
            this.saveSnapshot(editMessage.room);

            // notify all sockets about the update, if not empty
            if (editMessage.edits.length > 0) {
                this.transport.to(editMessage.room).emit(COMMANDS.remoteUpdateIncoming, connection.id);
            }

            this.sendServerChanges(doc, clientDoc, sendToClient);
        });
    }

    saveSnapshot(room) {
        const noRequestInProgress = !this.saveRequests[room];
        const checkQueueAndSaveAgain = () => {
            // if another save request is in the queue, save again
            const anotherRequestScheduled = this.saveQueue[room] === true;
            this.saveRequests[room] = false;
            if (anotherRequestScheduled) {
                this.saveQueue[room] = false;
                this.saveSnapshot(room);
            }
        };

        // only save if no save going on at the moment
        if (noRequestInProgress) {
            this.saveRequests[room] = true;
            // get data for saving
            this.getData(room, (err, data) => {
                // store data
                if (!err && data) {
                    this.adapter.storeData(room, data.serverCopy, checkQueueAndSaveAgain);
                } else {
                    checkQueueAndSaveAgain();
                }
            });

        } else {
            // schedule a new save request
            this.saveQueue[room] = true;
        }
    }

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
