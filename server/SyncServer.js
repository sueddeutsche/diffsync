const COMMANDS = require("../lib/commands");
const SyncService = require("./SyncService");
const UserService = require("./UserService");


class SyncServer {

    constructor(transport, adapter) {
        const syncService = new SyncService(adapter);
        const userService = new UserService();

        this.transport = transport;
        this.adapter = adapter;
        this.syncService = syncService;
        this.userService = userService;

        // new incoming user
        transport.on("connection", (connection) => {

            // establish connection with syncservice
            connection.on(COMMANDS.join, (room, initializeClient) =>
                syncService.joinConnection(connection, room, initializeClient)
            );

            // perform sync-cycle with server
            connection.on(COMMANDS.syncWithServer, (editMessage, sendClient) =>
                syncService.receiveEdit(connection, editMessage, sendClient)
            );

            // receive ping from client and update timestamp on user meta
            connection.on(COMMANDS.keepAlive, (room) =>
                userService.keepAlive(connection, room)
            );
        });

        // user joined successfully to syncservice
        syncService.on(SyncService.EVENTS.USER_JOINED, (userConnection, room) => {
            console.log(`User ${userConnection.id} connected`);
            userService.addUser(userConnection, room);

            userConnection.on("disconnect", () => {
                console.log(`User ${userConnection.id} disconnected`);
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
            userConnection.emit(COMMANDS.error, "Need to re-connect!");
        });

        userService.on(UserService.EVENTS.UPDATE_USERS, (room, users) => {
            transport.to(room).emit(COMMANDS.updateUsers, users);
        });
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
