/**
 * MESSAGING SYSTEM - SINGLE FILE SERVER
 * * Instructions:
 * 1. Paste this into a Node.js environment (e.g., Replit 'index.js').
 * 2. Ensure dependencies are installed: npm install express socket.io
 * 3. Run the file.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DATA STORAGE (In-Memory) ---
// Note: Data resets if the server restarts.
const users = {}; // { socketId: { name, pfp, currentRoom, id } }
const rooms = {}; // { roomId: { name, password, creator, isPrivate, users: [] } }

// --- SERVER LOGIC ---
io.on("connection", (socket) => {
  
  // 1. User Login / Profile Creation
  socket.on("login", ({ name, pfp }) => {
    users[socket.id] = {
      id: socket.id,
      name: name || `User-${socket.id.substr(0, 4)}`,
      pfp: pfp || "https://ui-avatars.com/api/?background=random&name=" + name,
      currentRoom: null,
    };
    socket.emit("login_success", users[socket.id]);
    io.emit("update_user_list", Object.values(users)); // Broadcast all users for PMs
    io.emit("update_room_list", getPublicRooms());
  });

  // 2. Update Profile
  socket.on("update_profile", ({ name, pfp }) => {
    if (users[socket.id]) {
      users[socket.id].name = name;
      users[socket.id].pfp = pfp;
      io.emit("update_user_list", Object.values(users));
      
      const roomID = users[socket.id].currentRoom;
      if (roomID && rooms[roomID]) {
        io.to(roomID).emit("room_users", getRoomUsers(roomID));
      }
    }
  });

  // 3. Create Group Chat
  socket.on("create_room", ({ name, password }) => {
    const roomId = "room_" + Date.now();
    rooms[roomId] = {
      id: roomId,
      name: name,
      password: password,
      creator: socket.id,
      isPrivate: false,
      users: [],
    };
    io.emit("update_room_list", getPublicRooms());
    socket.emit("room_created", roomId);
  });

  // 4. Start Private Message (1 on 1)
  socket.on("start_pm", (targetUserId) => {
    if (!users[targetUserId]) return;
    
    // Create a unique ID based on alphabetical order of IDs so A+B is same as B+A
    const sortedIds = [socket.id, targetUserId].sort();
    const roomId = `pm_${sortedIds[0]}_${sortedIds[1]}`;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        name: "Private Chat",
        password: null, // PMs don't use passwords, they use invite logic
        creator: null, 
        isPrivate: true,
        users: [],
      };
    }
    
    // Force both users to join logically
    socket.emit("join_pm_success", roomId);
    io.to(targetUserId).emit("request_pm_join", roomId);
  });

  // 5. Join Room (GC or PM)
  socket.on("join_room", ({ roomId, password }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error_msg", "Room does not exist.");

    // Check Password if it's a GC and has one
    if (!room.isPrivate && room.password && room.password !== password) {
      return socket.emit("error_msg", "Incorrect Password.");
    }

    leaveCurrentRoom(socket); // Leave old room first

    socket.join(roomId);
    room.users.push(socket.id);
    users[socket.id].currentRoom = roomId;

    // Send Room Data to user
    socket.emit("joined_room", {
      id: roomId,
      name: room.isPrivate ? "Private Chat" : room.name,
      isPrivate: room.isPrivate,
      amICreator: room.creator === socket.id,
    });

    // Notify others in room
    io.to(roomId).emit("system_message", `${users[socket.id].name} joined.`);
    io.to(roomId).emit("room_users", getRoomUsers(roomId));
  });

  // 6. Send Message
  socket.on("send_message", (text) => {
    const user = users[socket.id];
    if (!user || !user.currentRoom) return;

    const roomId = user.currentRoom;
    io.to(roomId).emit("chat_message", {
      user: user,
      text: text,
      time: new Date().toLocaleTimeString(),
    });
  });

  // 7. Kick User (GC Creator Only)
  socket.on("kick_user", (targetId) => {
    const user = users[socket.id];
    const roomId = user.currentRoom;
    const room = rooms[roomId];

    if (room && !room.isPrivate && room.creator === socket.id) {
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            leaveCurrentRoom(targetSocket); // Standard leave logic
            targetSocket.emit("kicked");
            targetSocket.emit("error_msg", "You were kicked from the group.");
        }
    }
  });

  // 8. Leave Room / Disconnect
  socket.on("leave_room", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    delete users[socket.id];
    io.emit("update_user_list", Object.values(users));
  });
});

// Helper: Get users in a specific room
function getRoomUsers(roomId) {
  if (!rooms[roomId]) return [];
  return rooms[roomId].users.map((id) => ({
    id: id,
    name: users[id] ? users[id].name : "Unknown",
    pfp: users[id] ? users[id].pfp : "",
    isCreator: rooms[roomId].creator === id
  }));
}

// Helper: Get public rooms for the lobby
function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => !r.isPrivate)
    .map(r => ({ id: r.id, name: r.name, hasPassword: !!r.password }));
}

// Helper: Handle leaving logic
function leaveCurrentRoom(socket) {
  const user = users[socket.id];
  if (!user || !user.currentRoom) return;

  const roomId = user.currentRoom;
  const room = rooms[roomId];

  if (room) {
    // Remove user from room array
    room.users = room.users.filter((id) => id !== socket.id);
    user.currentRoom = null;

    // Notify remaining users
    io.to(roomId).emit("system_message", `${user.name} left.`);
    io.to(roomId).emit("room_users", getRoomUsers(roomId));

    // DELETION LOGIC:
    // User requirement: "GCs are only deleted if there are less than 2 people in it"
    // Standard interpretation: If count drops below 2 (i.e. 1 or 0), delete.
    // However, if we delete on 1 person, a creator can never wait for a friend.
    // Compromise logic: If it drops to 0, it is definitely deleted. 
    // If it is a GC and drops to 1, we will theoretically allow it to stay open so people can join,
    // otherwise the chat is unusable. (Technically < 2 includes 0).
    
    if (room.users.length === 0) {
        delete rooms[roomId];
        io.emit("update_room_list", getPublicRooms());
    } 
    // If you strictly want it to close if 1 person is left (preventing solo waiting):
    // Uncomment the lines below.
    /*
    else if (!room.isPrivate && room.users.length < 2) {
       // Kick the remaining person
       const lastUserId = room.users[0];
       const lastSocket = io.sockets.sockets.get(lastUserId);
       if(lastSocket) {
           lastSocket.emit("error_msg", "Room closed: not enough people.");
           lastSocket.emit("kicked"); // Reuse kicked to force to lobby
           users[lastUserId].currentRoom = null;
       }
       delete rooms[roomId];
       io.emit("update_room_list", getPublicRooms());
    }
    */
  }
}

// --- FRONTEND (SERVED AS STRING) ---
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Browser Messenger</title>
    <style>
        :root {
            /* Black-Orange Theme (Default) */
            --bg-color: #1a1a1a;
            --text-color: #f0f0f0;
            --primary: #ff8800; 
            --secondary: #2d2d2d;
            --accent: #ffaa44;
            --msg-bg: #333;
            --sidebar-bg: #000;
        }

        body.theme-purple {
            /* Dark Purple Theme */
            --bg-color: #1a0b1a;
            --text-color: #f0d0f0;
            --primary: #9b4dca;
            --secondary: #2d1b2d;
            --accent: #bf7ddf;
            --msg-bg: #331533;
            --sidebar-bg: #110511;
        }

        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg-color); color: var(--text-color); margin: 0; display: flex; height: 100vh; overflow: hidden; }
        
        #app { display: flex; width: 100%; height: 100%; }
        
        /* Sidebar */
        .sidebar { width: 260px; background: var(--sidebar-bg); border-right: 1px solid var(--secondary); display: flex; flex-direction: column; padding: 15px; box-sizing: border-box;}
        .main-content { flex: 1; display: flex; flex-direction: column; background: var(--bg-color); position: relative; }

        /* Generic UI */
        button { background: var(--primary); color: white; border: none; padding: 10px; cursor: pointer; border-radius: 5px; margin: 5px 0; font-weight: bold; transition: 0.2s; }
        button:hover { opacity: 0.9; transform: translateY(-1px); }
        input { background: var(--secondary); border: 1px solid #444; color: var(--text-color); padding: 10px; border-radius: 5px; width: 100%; box-sizing: border-box; margin-bottom: 10px; outline: none; }
        input:focus { border-color: var(--primary); }

        /* Login Screen */
        #login-screen { position: absolute; top:0; left:0; width:100%; height:100%; background: var(--bg-color); display: flex; justify-content: center; align-items: center; z-index: 100; flex-direction: column; }
        .login-box { background: var(--secondary); padding: 40px; border-radius: 10px; width: 300px; text-align: center; border: 1px solid var(--primary); box-shadow: 0 0 20px rgba(0,0,0,0.5); }
        .login-box img { width: 100px; height: 100px; border-radius: 50%; margin-bottom: 15px; object-fit: cover; background: #000; border: 2px solid var(--primary);}

        /* Sidebar Items */
        .room-list, .user-list { overflow-y: auto; flex: 1; margin-bottom: 10px; }
        .room-item, .user-item { padding: 10px; border-bottom: 1px solid var(--secondary); cursor: pointer; display: flex; justify-content: space-between; align-items: center; border-radius: 4px; }
        .room-item:hover, .user-item:hover { background: var(--secondary); }
        .section-title { color: var(--accent); margin-top: 20px; margin-bottom: 5px; font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; }

        /* Chat Area */
        #chat-screen { display: none; flex-direction: column; height: 100%; width: 100%; }
        .chat-header { padding: 15px; background: var(--secondary); border-bottom: 1px solid var(--primary); display: flex; justify-content: space-between; align-items: center; }
        .chat-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 10px; }
        .chat-input-area { padding: 20px; background: var(--secondary); display: flex; gap: 10px; }
        
        .message { background: var(--msg-bg); padding: 10px 15px; border-radius: 10px; max-width: 70%; word-wrap: break-word; }
        .message.mine { align-self: flex-end; background: var(--primary); color: #fff; }
        .message .meta { font-size: 0.75em; opacity: 0.7; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;}
        .message .meta img { width: 20px; height: 20px; border-radius: 50%; }

        .hidden { display: none !important; }
        
        .theme-toggle-btn { position: absolute; top: 15px; right: 15px; z-index: 200; background: transparent; border: 1px solid var(--primary); font-size: 0.8em;}
    </style>
</head>
<body>

    <button class="theme-toggle-btn" onclick="toggleTheme()">🎨 Switch Theme</button>

    <div id="login-screen">
        <div class="login-box">
            <h2 style="margin-top:0;">Join Chat</h2>
            <img id="preview-pfp" src="https://ui-avatars.com/api/?name=User" alt="PFP">
            <input type="text" id="username-input" placeholder="Display Name" oninput="updatePreview()">
            <input type="text" id="pfp-input" placeholder="Image URL (Optional)" oninput="updatePreview()">
            <button onclick="login()" style="width:100%;">ENTER</button>
        </div>
    </div>

    <div id="app" class="hidden">
        
        <div class="sidebar">
            <div class="profile-summary" style="padding-bottom: 15px; border-bottom: 1px solid var(--primary); margin-bottom: 10px; display:flex; align-items:center; gap: 10px;">
                <img id="my-pfp" src="" style="width:40px; height:40px; border-radius:50%; object-fit:cover;">
                <div style="flex:1; overflow:hidden;">
                    <div id="my-name" style="font-weight:bold; white-space:nowrap;"></div>
                    <div style="font-size:0.7em; opacity:0.7; cursor:pointer;" onclick="editProfile()">Click to Edit</div>
                </div>
            </div>

            <div class="section-title">Group Chats</div>
            <button onclick="showCreateRoom()" style="font-size:0.8em;">+ New Group</button>
            <div id="room-list" class="room-list"></div>

            <div class="section-title">Online Users</div>
            <div id="user-list" class="user-list"></div>
        </div>

        <div class="main-content">
            
            <div id="lobby-view" style="display:flex; justify-content:center; align-items:center; height:100%; color: #666; flex-direction: column;">
                <h1>Welcome</h1>
                <p>Select a Group Chat or click a User to Private Message.</p>
            </div>

            <div id="chat-screen">
                <div class="chat-header">
                    <div style="display:flex; flex-direction:column;">
                        <span id="chat-room-name" style="font-size: 1.2em; font-weight: bold;">Room Name</span>
                        <span id="chat-user-count" style="font-size: 0.8em; opacity: 0.8;"></span>
                    </div>
                    <button onclick="leaveRoom()" style="background: #cc3300; font-size: 0.8em;">Exit Chat</button>
                </div>
                
                <div id="room-members" style="padding: 10px; background: rgba(0,0,0,0.2); font-size: 0.8em; display:none; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid #444;"></div>

                <div id="chat-messages" class="chat-messages"></div>

                <div class="chat-input-area">
                    <input type="text" id="msg-input" placeholder="Type a message..." style="margin:0;" onkeydown="if(event.key==='Enter') sendMessage()">
                    <button onclick="sendMessage()" style="margin:0; width: 80px;">Send</button>
                </div>
            </div>

        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let myUser = null;

        // --- THEME LOGIC ---
        function toggleTheme() {
            document.body.classList.toggle('theme-purple');
        }

        // --- LOGIN LOGIC ---
        function updatePreview() {
            const name = document.getElementById('username-input').value || 'User';
            const url = document.getElementById('pfp-input').value;
            // Use UI Avatars if no URL provided
            const fallback = "https://ui-avatars.com/api/?background=random&name=" + encodeURIComponent(name);
            
            // Try to load image, fallback on error
            const img = document.getElementById('preview-pfp');
            img.onerror = () => { img.src = fallback; };
            img.src = url && url.length > 5 ? url : fallback;
        }

        function login() {
            const name = document.getElementById('username-input').value.trim();
            const pfp = document.getElementById('preview-pfp').src;
            if(!name) return alert("Name is required");
            socket.emit('login', { name, pfp });
        }

        function editProfile() {
            const newName = prompt("New Name:", myUser.name);
            if(newName) {
                const newPfp = prompt("New PFP URL (leave empty to keep current):");
                socket.emit('update_profile', { name: newName, pfp: newPfp || myUser.pfp });
            }
        }

        socket.on('login_success', (user) => {
            myUser = user;
            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
            updateSidebarSelf();
        });

        function updateSidebarSelf() {
            document.getElementById('my-name').innerText = myUser.name;
            document.getElementById('my-pfp').src = myUser.pfp;
        }

        // --- LISTS UPDATES ---
        socket.on('update_room_list', (rooms) => {
            const container = document.getElementById('room-list');
            container.innerHTML = '';
            rooms.forEach(room => {
                const div = document.createElement('div');
                div.className = 'room-item';
                div.innerHTML = \`
                    <span>\${room.name} \${room.hasPassword ? '🔒' : ''}</span> 
                    <button style="font-size:0.6em; padding:4px 8px;" onclick="joinRoom('\${room.id}', \${room.hasPassword})">Join</button>
                \`;
                container.appendChild(div);
            });
        });

        socket.on('update_user_list', (users) => {
            const container = document.getElementById('user-list');
            container.innerHTML = '';
            users.forEach(u => {
                if(u.id === socket.id) return; // Don't show self in list
                const div = document.createElement('div');
                div.className = 'user-item';
                div.innerHTML = \`
                    <div style="display:flex; align-items:center; gap:8px;">
                        <img src="\${u.pfp}" style="width:25px; height:25px; border-radius:50%; object-fit:cover;">
                        <span>\${u.name}</span>
                    </div>
                    <button style="font-size:0.6em; padding:4px 8px; background: var(--accent);" onclick="startPM('\${u.id}')">Msg</button>
                \`;
                container.appendChild(div);
            });
        });

        // --- ACTIONS ---
        function showCreateRoom() {
            const name = prompt("Enter Group Chat Name:");
            if(!name) return;
            const password = prompt("Enter Password (leave empty for open group):");
            socket.emit('create_room', { name, password });
        }

        function joinRoom(id, hasPass) {
            let password = '';
            if(hasPass) {
                password = prompt("This room requires a password:");
            }
            socket.emit('join_room', { roomId: id, password });
        }

        function startPM(targetId) {
            socket.emit('start_pm', targetId);
        }

        socket.on('request_pm_join', (roomId) => {
            // Auto join PMs or ask? Let's auto-join to make it seamless like Messenger
            socket.emit('join_room', { roomId: roomId });
        });
        
        socket.on('join_pm_success', (roomId) => {
            socket.emit('join_room', { roomId: roomId });
        });

        // --- CHAT ROOM UI ---
        socket.on('joined_room', (roomData) => {
            document.getElementById('lobby-view').style.display = 'none';
            document.getElementById('chat-screen').style.display = 'flex';
            document.getElementById('chat-room-name').innerText = roomData.name;
            document.getElementById('chat-messages').innerHTML = ''; 
            
            // Show members area only for Groups
            document.getElementById('room-members').style.display = roomData.isPrivate ? 'none' : 'flex';
        });

        socket.on('room_users', (users) => {
            document.getElementById('chat-user-count').innerText = \`\${users.length} active\`;
            
            const list = document.getElementById('room-members');
            list.innerHTML = '';
            
            // Sort: Me, then Creator, then others
            users.forEach(u => {
                const div = document.createElement('div');
                div.style.background = '#444';
                div.style.padding = '3px 8px';
                div.style.borderRadius = '10px';
                div.style.display = 'flex';
                div.style.alignItems = 'center';
                div.style.gap = '5px';
                
                div.innerHTML = \`<img src="\${u.pfp}" style="width:15px; height:15px; border-radius:50%;"> \${u.name} \${u.isCreator ? '★' : ''}\`;

                // Kick Button Logic: I am creator AND u is not me
                const iAmCreator = users.find(x => x.id === socket.id && x.isCreator);
                if(iAmCreator && u.id !== socket.id) {
                    const kickBtn = document.createElement('span');
                    kickBtn.innerText = ' ✖';
                    kickBtn.style.color = '#ff4444';
                    kickBtn.style.cursor = 'pointer';
                    kickBtn.title = 'Kick User';
                    kickBtn.onclick = () => {
                        if(confirm(\`Kick \${u.name} from the group?\`)) {
                            socket.emit('kick_user', u.id);
                        }
                    };
                    div.appendChild(kickBtn);
                }
                list.appendChild(div);
            });
        });

        socket.on('chat_message', (msg) => {
            const div = document.createElement('div');
            const isMine = msg.user.id === socket.id;
            div.className = 'message ' + (isMine ? 'mine' : '');
            
            div.innerHTML = \`
                <div class="meta">
                    <img src="\${msg.user.pfp}">
                    <span>\${msg.user.name}</span>
                    <span style="margin-left:auto; font-size:0.8em;">\${msg.time}</span>
                </div>
                <div class="text">\${msg.text}</div>
            \`;
            const chatBox = document.getElementById('chat-messages');
            chatBox.appendChild(div);
            chatBox.scrollTop = chatBox.scrollHeight;
        });

        socket.on('system_message', (text) => {
            const div = document.createElement('div');
            div.style.textAlign = 'center';
            div.style.color = 'var(--accent)';
            div.style.fontSize = '0.75em';
            div.style.margin = '10px 0';
            div.innerText = text;
            document.getElementById('chat-messages').appendChild(div);
        });

        socket.on('error_msg', (msg) => {
            alert(msg);
        });

        socket.on('kicked', () => {
            leaveRoomUI();
        });

        function sendMessage() {
            const input = document.getElementById('msg-input');
            const text = input.value.trim();
            if(!text) return;
            socket.emit('send_message', text);
            input.value = '';
        }

        function leaveRoom() {
            socket.emit('leave_room');
            leaveRoomUI();
        }

        function leaveRoomUI() {
            document.getElementById('chat-screen').style.display = 'none';
            document.getElementById('lobby-view').style.display = 'flex';
        }
    </script>
</body>
</html>
`;

// --- START SERVER ---
app.get("/", (req, res) => {
  res.send(HTML_CONTENT);
});

// Render/Replit provide a port via env, or default to 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
