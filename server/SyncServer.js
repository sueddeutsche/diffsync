const SyncService = require("./SyncService");
const UserService = require("./UserService");


class SyncServer {

    constructor(transport, adapter) {
        UserService.init(transport);
        this.syncService = new SyncService(adapter, transport);

        this.syncService.on("new-user", (userConnection, room) => {
            UserService.addUser(userConnection, room);
        });
    }
}


module.exports = SyncServer;
