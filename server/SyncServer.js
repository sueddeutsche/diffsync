const COMMANDS = require("../lib/commands");
const SyncService = require("./SyncService");
const UserService = require("./UserService");


function log(...args) {
    console.log("SyncService:", ...args);
}


class SyncServer {

    constructor(transport, adapter, auth) {
        const syncService = new SyncService(adapter);
        const userService = new UserService();

        this.transport = transport;
        this.adapter = adapter;
        this.syncService = syncService;
        this.userService = userService;

        // user joined successfully to syncservice
        syncService.on(SyncService.EVENTS.USER_JOINED, (userConnection, room) => {
            userService.addUser(userConnection, room);

            userConnection.on("disconnect", () => {
                userService.removeUser(userConnection, room);
            });

            userConnection.on(COMMANDS.updateUserData, (userRoom, userMeta) => {
                userService.updateMetaData(userConnection, userRoom, userMeta);
            });
        });

        // send request to clients to sync with server
        syncService.on(SyncService.EVENTS.SERVER_SYNC, (userConnection, room) => {
            transport.to(room).emit(COMMANDS.remoteUpdateIncoming, userConnection.id);
        });

        // user invalid, reconnect
        syncService.on(SyncService.EVENTS.ERROR_INVALID_CONNECTION, (userConnection, room) => {
            userConnection.emit(COMMANDS.error, new Error("Invalid connection - reconnect."));
        });

        userService.on(UserService.EVENTS.UPDATE_USERS, (room, users) => {
            transport.to(room).emit(COMMANDS.updateUsers, users);
        });

        this.transport.on("connection", (connection) => this.joinUser(connection, auth));
    }

    close() {
        this.transport.emit(COMMANDS.close, "SyncServer is shutting down");
    }

    joinUser(connection, auth) {
        // establish connection with syncservice
        connection.on(COMMANDS.join, (credentials, room, initializeClient) => {
            if (auth == null) {
                this._joinUser(connection, room, initializeClient);
                return;
            }

            Promise.resolve(auth(connection, credentials))
                .then((isAuthenticated) => {
                    if (isAuthenticated === false) {
                        log(`[ABORT] join request ${connection.id} -- auth failed`);
                        connection.emit(COMMANDS.error, new Error("Authorization failed"));
                        return;
                    }
                    this._joinUser(connection, room, initializeClient);
                });
        });
    }

    _joinUser(connection, room, initializeClient) {
        this.syncService.joinConnection(connection, room, initializeClient);

        // perform sync-cycle with server
        connection.on(COMMANDS.syncWithServer, (editMessage, sendToClient) => {
            this.syncService.receiveEdit(connection, editMessage, sendToClient);
        });

        // receive ping from client and update timestamp on user meta
        connection.on(COMMANDS.keepAlive, (roomId) =>
            this.userService.keepAlive(connection, roomId)
        );
    }

    getAdapter() {
        return this.adapter;
    }

    getUserService() {
        return this.userService;
    }

    getSyncService() {
        return this.syncService;
    }
}


module.exports = SyncServer;
