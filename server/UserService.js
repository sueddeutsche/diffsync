const EventEmitter = require("events").EventEmitter;
const eventMap = require("../lib/eventMap");


const EVENTS = eventMap({
    UPDATE_USERS: "update:users",
    ROOM_EMPTY: "room:empty",
});


class UserService extends EventEmitter {

    constructor() {
        super();
        this.users = {};
        this.EVENTS = EVENTS;
    }

    getUsers(room) {
        if (room) {
            if (this.users[room]) {
                return this.users[room];
            }
            return false;
        }
        return this.users;
    }

    removeUser(connection, room) {
        this.users[room] = this.users[room].filter((registeredUser) => registeredUser.id !== connection.id);
        this.emit(EVENTS.UPDATE_USERS, room, this.users[room]);
        if (this.users[room].length === 0) {
            this.emit(EVENTS.ROOM_EMPTY, room);
        }
    }

    updateMetaData(connection, room, meta) {
        const currentUser = this.getUser(room, connection.id);
        if (currentUser) {
            // @todo allow removal of properties
            Object.assign(currentUser, meta);
            this.emit(EVENTS.UPDATE_USERS, room, this.users[room]);
        }
    }

    // track users per room
    addUser(connection, room) {
        const user = { id: connection.id, room, joined: new Date(), lastAction: new Date() };
        this.users[room] = this.users[room] || [];
        this.users[room].push(user);
        this.emit(EVENTS.UPDATE_USERS, room, this.users[room]);
    }

    keepAlive(userConnection, room) {
        const user = this.getUser(room, userConnection.id);
        if (user) {
            user.lastAction = new Date();
            this.emit(EVENTS.UPDATE_USERS, room, this.users[room]);
        }
    }

    getUser(room, id) {
        const users = this.users[room];
        if (users == null || users.length === 0) {
            console.log(`There is no user ${id} in room ${room}`, room);
            return false;
        }
        for (let i = 0; i < users.length; i += 1) {
            if (users[i].id === id) {
                return users[i];
            }
        }
        return false;
    }
}


module.exports = UserService;
module.exports.EVENTS = EVENTS;
