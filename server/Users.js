const COMMANDS = require("../lib/commands");


const Users = {

    users: {},

    init(transport) {
        if (this.transport == null) {
            this.transport = transport;
        }
    },

    getUsers(room) {
        if (room) {
            if (this.users[room]) {
                return this.users[room]
            }
            return false;
        }
        return this.users;
    },

    // track users per room
    addUser(connection, room) {
        const user = { id: connection.id };
        this.users[room] = this.users[room] || [];
        this.users[room].push(user);

        // user disconnected
        connection.on("disconnect", () => {
            this.users[room] = this.users[room].filter((user) => user.id !== connection.id);
            // console.log(`User disconnected from room ${room}`, this.users[room]);
            this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
        });

        // request: update user meta data
        connection.on(COMMANDS.updateUserData, (roomId, meta) => {
            const user = this.getUser(roomId, meta.id);
            if (user) {
                // console.log("Update user meta and notify");
                // @todo allow removal of properties
                Object.assign(user, meta);
                this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
            }
        });

        // console.log(`User connected to room ${room}`, this.users[room]);
        this.transport.to(room).emit(COMMANDS.updateUsers, this.users[room]);
    },

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


module.exports = Users;
