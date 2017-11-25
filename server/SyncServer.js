const SyncService = require("./SyncService");
const UserService = require("./UserService");


class SyncServer {

    constructor(transport, adapter) {
        UserService.init(transport);
        this.syncService = new SyncService(adapter, transport);

        this.syncService.on(SyncService.EVENTS.USER_JOINED, (userConnection, room) => {
            UserService.addUser(userConnection, room);
        });

        this.syncService.on(SyncService.EVENTS.USER_EDIT, (userConnection, room) => {
            UserService.keepAlive(userConnection, room);
        });
    }
}


module.exports = SyncServer;
