const COMMANDS = require("../lib/commands");


const UserService = {

    users: {},

    init(transport) {
        if (this.transport == null) {
            this.transport = transport;
        }
    },

    getUsers(room) {
        if (room) {
            if (this.users[room]) {
                return this.users[room];
            }
            return false;
        }
        return this.users;
    },

    // track users per room
    addUser(connection, room) {
        const user = { id: connection.id, room, joined: new Date(), lastAction: new Date() };
        this.users[room] = this.users[room] || [];
        this.users[room].push(user);

        // user disconnected
        connection.on("disconnect", () => {
            this.users[room] = this.users[room].filter((registeredUser) => registeredUser.id !== connection.id);
            this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
        });

        // request: update user meta data
        connection.on(COMMANDS.updateUserData, (roomId, meta) => {
            const currentUser = this.getUser(roomId, meta.id);
            if (currentUser) {
                // console.log("Update user meta and notify");
                // @todo allow removal of properties
                Object.assign(currentUser, meta);
                this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
            }
        });

        // console.log(`User connected to room ${room}`, this.users[room]);
        this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
    },

    keepAlive(userConnection, room) {
        const user = this.getUser(room, userConnection.id);
        if (user) {
            user.lastAction = new Date();
            this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
        }
    },

    getUser(room, id) {
        const users = this.users[room];
        if (users == null || users.length === 0) {
            console.log(`There is no user ${id} in room ${room}`);
            return false;
        }
        for (let i = 0; i < users.length; i += 1) {
            if (users[i].id === id) {
                return users[i];
            }
        }
        return false;
    }
};


module.exports = UserService;