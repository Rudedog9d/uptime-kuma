const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const axios = require('axios');
const dayjs = require("dayjs");
const {R} = require("redbean-node");
const passwordHash = require('password-hash');
const jwt = require('jsonwebtoken');
const Monitor = require("./model/monitor");
const {sleep} = require("./util");


let stop = false;
let interval = 6000;
let totalClient = 0;
let jwtSecret = null;
let loadFromDatabase = true;
let monitorList = {};

(async () => {

    R.setup('sqlite', {
        filename: '../data/kuma.db'
    });
    R.freeze(true)
    await R.autoloadModels("./model");

    await initDatabase();

    app.use('/', express.static("public"));

    io.on('connection', async (socket) => {
        console.log('a user connected');
        totalClient++;

        socket.on('disconnect', () => {
            console.log('user disconnected');
            totalClient--;
        });

        // Public API

        socket.on("loginByToken", async (token, callback) => {

            try {
                let decoded = jwt.verify(token, jwtSecret);

                console.log("Username from JWT: " + decoded.username)

                let user = await R.findOne("user", " username = ? AND active = 1 ", [
                    decoded.username
                ])

                if (user) {
                    await afterLogin(socket, user)

                    callback({
                        ok: true,
                    })
                } else {
                    callback({
                        ok: false,
                        msg: "The user is inactive or deleted."
                    })
                }
            } catch (error) {
                callback({
                    ok: false,
                    msg: "Invalid token."
                })
            }

        });

        socket.on("login", async (data, callback) => {
            console.log("Login")

            let user = await R.findOne("user", " username = ? AND active = 1 ", [
                data.username
            ])

            if (user && passwordHash.verify(data.password, user.password)) {

                await afterLogin(socket, user)

                callback({
                    ok: true,
                    token: jwt.sign({
                        username: data.username
                    }, jwtSecret)
                })
            } else {
                callback({
                    ok: false,
                    msg: "Incorrect username or password."
                })
            }

        });

        socket.on("logout", async (callback) => {
            socket.leave(socket.userID)
            socket.userID = null;
            callback();
        });

        // Auth Only API

        socket.on("add", async (monitor, callback) => {
            try {
                checkLogin(socket)

                let bean = R.dispense("monitor")
                bean.import(monitor)
                bean.user_id = socket.userID
                await R.store(bean)

                callback({
                    ok: true,
                    msg: "Added Successfully.",
                    monitorID: bean.id
                });

                await sendMonitorList(socket);

            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message
                });
            }
        });

        socket.on("getMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket)

                console.log(`Get Monitor: ${monitorID} User ID: ${socket.userID}`)

                let bean = await R.findOne("monitor", " id = ? AND user_id = ? ", [
                    monitorID,
                    socket.userID,
                ])

                callback({
                    ok: true,
                    monitor: bean.toJSON(),
                });

            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message
                });
            }
        });

        // Start or Resume the monitor
        socket.on("resumeMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket)
                await startMonitor(socket.userID, monitorID);
                await sendMonitorList(socket);

                callback({
                    ok: true,
                    msg: "Paused Successfully."
                });

            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message
                });
            }
        });

        socket.on("pauseMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket)
                await pauseMonitor(socket.userID, monitorID)
                await sendMonitorList(socket);

                callback({
                    ok: true,
                    msg: "Paused Successfully."
                });


            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message
                });
            }
        });

        socket.on("deleteMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket)

                console.log(`Delete Monitor: ${monitorID} User ID: ${socket.userID}`)

                if (monitorID in monitorList) {
                    monitorList[monitorID].stop();
                    delete monitorList[monitorID]
                }

                await R.exec("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [
                    monitorID,
                    socket.userID
                ]);

                callback({
                    ok: true,
                    msg: "Deleted Successfully."
                });

                await sendMonitorList(socket);

            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message
                });
            }
        });

        socket.on("changePassword", async (password, callback) => {
            try {
                checkLogin(socket)

                if (! password.currentPassword) {
                    throw new Error("Invalid new password")
                }

                let user = await R.findOne("user", " id = ? AND active = 1 ", [
                    socket.userID
                ])

                if (user && passwordHash.verify(password.currentPassword, user.password)) {

                    await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
                        passwordHash.generate(password.newPassword),
                        socket.userID
                    ]);

                    callback({
                        ok: true,
                        msg: "Password has been updated successfully."
                    })
                } else {
                    throw new Error("Incorrect current password")
                }

            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message
                });
            }
        });
    });

    server.listen(3001, () => {
        console.log('Listening on 3001');
        startMonitors();
    });

})();

async function checkOwner(userID, monitorID) {
    let row = await R.getRow("SELECT id FROM monitor WHERE id = ? AND user_id = ? ", [
        monitorID,
        userID,
    ])

    if (! row) {
        throw new Error("You do not own this monitor.");
    }
}

async function sendMonitorList(socket) {
    io.to(socket.userID).emit("monitorList", await getMonitorJSONList(socket.userID))
}

async function afterLogin(socket, user) {
    socket.userID = user.id;
    socket.join(user.id)
    socket.emit("monitorList", await getMonitorJSONList(user.id))
}

async function getMonitorJSONList(userID) {
    let result = [];

    let monitorList = await R.find("monitor", " user_id = ? ORDER BY weight DESC ", [
        userID
    ])

    for (let monitor of monitorList) {
        result.push(monitor.toJSON())
    }

    return result;
}

function checkLogin(socket) {
    if (! socket.userID) {
        throw new Error("You are not logged in.");
    }
}

async function initDatabase() {
    let jwtSecretBean = await R.findOne("setting", " `key` = ? ", [
        "jwtSecret"
    ]);

    if (! jwtSecretBean) {
        console.log("JWT secret is not found, generate one.")
        jwtSecretBean = R.dispense("setting")
        jwtSecretBean.key = "jwtSecret"

        jwtSecretBean.value = passwordHash.generate(dayjs() + "")
        await R.store(jwtSecretBean)
    } else {
        console.log("Load JWT secret from database.")
    }

    jwtSecret = jwtSecretBean.value;
}

async function startMonitor(userID, monitorID) {
    await checkOwner(userID, monitorID)

    console.log(`Resume Monitor: ${monitorID} User ID: ${userID}`)

    await R.exec("UPDATE monitor SET active = 1 WHERE id = ? AND user_id = ? ", [
        monitorID,
        userID
    ]);

    let monitor = await R.findOne("monitor", " id = ? ", [
        monitorID
    ])

    monitorList[monitor.id] = monitor;
    monitor.start(io)
}

async function pauseMonitor(userID, monitorID) {
    await checkOwner(userID, monitorID)

    console.log(`Pause Monitor: ${monitorID} User ID: ${userID}`)

    await R.exec("UPDATE monitor SET active = 0 WHERE id = ? AND user_id = ? ", [
        monitorID,
        userID
    ]);

    if (monitorID in monitorList) {
        monitorList[monitorID].stop();
    }
}

/**
 * Resume active monitors
 */
async function startMonitors() {
    let list = await R.find("monitor", " active = 1 ")

    for (let monitor of list) {
        monitor.start(io)
        monitorList[monitor.id] = monitor;
    }
}
