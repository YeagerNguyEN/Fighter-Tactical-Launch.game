// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Serve the 'public' directory which will contain index.html
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
const PLACEMENT_TIME_LIMIT = 30000; // 30 seconds
const ROWS = 10;
const COLS = 10;
const PLANES_PER_PLAYER = 3;
const BASE_PLANE_SHAPE = [
  [0, 0], // Head relative to its own position
  [-1, 1],
  [0, 1],
  [1, 1],
  [0, 2],
  [-1, 3],
  [0, 3],
  [1, 3],
];
const DIRECTIONS = ["down", "left", "up", "right"];

// --- HELPER FUNCTIONS FOR RANDOM BOARD GENERATION ---
function getRotatedShape(direction) {
  switch (direction) {
    case "down":
      return BASE_PLANE_SHAPE;
    case "left":
      return BASE_PLANE_SHAPE.map(([x, y]) => [-y, x]);
    case "up":
      return BASE_PLANE_SHAPE.map(([x, y]) => [-x, -y]);
    case "right":
      return BASE_PLANE_SHAPE.map(([x, y]) => [y, -x]);
    default:
      return BASE_PLANE_SHAPE;
  }
}

function canPlacePlane(board, row, col, shape) {
  for (const [dx, dy] of shape) {
    const r = row + dy;
    const c = col + dx;
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== 0) {
      return false;
    }
  }
  return true;
}

function placePlaneOnBoard(board, headRow, headCol, shape) {
  board[headRow + shape[0][1]][headCol + shape[0][0]] = "H"; // Place head
  for (let i = 1; i < shape.length; i++) {
    const [dx, dy] = shape[i];
    board[headRow + dy][headCol + dx] = "B"; // Place body parts
  }
}

function generateRandomPlaceBoard() {
  let board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
  let planesPlaced = 0;

  let attempts = 0; // Failsafe to prevent infinite loops
  while (planesPlaced < PLANES_PER_PLAYER && attempts < 1000) {
    const randomRow = Math.floor(Math.random() * ROWS);
    const randomCol = Math.floor(Math.random() * COLS);
    const randomDirection =
      DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
    const shape = getRotatedShape(randomDirection);

    if (canPlacePlane(board, randomRow, randomCol, shape)) {
      placePlaneOnBoard(board, randomRow, randomCol, shape);
      planesPlaced++;
    }
    attempts++;
  }
  return board;
}
// --- END HELPER FUNCTIONS ---

const startShootingPhase = (roomCode) => {
  const room = rooms[roomCode];
  if (!room || room.state !== "placing") {
    return;
  }

  // Clear the timer if it exists
  if (room.placementTimer) {
    clearTimeout(room.placementTimer);
    room.placementTimer = null;
  }

  // Ensure all players have a placeBoard. If not, generate a random one.
  room.players.forEach((player) => {
    if (!player.placeBoard) {
      player.placeBoard = generateRandomPlaceBoard();
      player.ready = true;
      console.log(
        `[Server] Player ${player.playerIndex} (${player.id}) did not submit placeBoard. Generated random board for them.`
      );
    }
  });

  room.state = "shooting";
  io.to(roomCode).emit("shootingPhaseStart");
  io.to(roomCode).emit("newTurn", room.currentTurnIndex);

  console.log(
    `[Server] Room ${roomCode}: SHOOTING PHASE STARTED. Turn: Player ${room.currentTurnIndex}.`
  );
};

io.on("connection", (socket) => {
  console.log(`[Server] User connected: ${socket.id}`);

  socket.on("createRoom", () => {
    let roomCode;
    do {
      roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    } while (rooms[roomCode]);

    rooms[roomCode] = {
      players: [
        { id: socket.id, playerIndex: 0, ready: false, placeBoard: null },
      ],
      state: "waiting",
      currentTurnIndex: 0,
      placementTimer: null,
    };

    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
    console.log(`[Server] Room ${roomCode} created by ${socket.id}`);
  });

  socket.on("joinRoom", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit("error", "Room does not exist.");
    }
    if (room.players.length >= 2) {
      return socket.emit("error", "Room is full.");
    }

    socket.join(roomCode);
    room.players.push({
      id: socket.id,
      playerIndex: 1,
      ready: false,
      placeBoard: null,
    });
    room.state = "placing";
    console.log(
      `[Server] ${socket.id} joined room ${roomCode}. Room state: ${room.state}`
    );

    // --- REFACTORED LOGIC ---
    // 1. Directly inform the joining player of their details
    socket.emit("joinedRoom", {
      roomCode,
      playerIndex: 1, // Joiner is always player 1
    });

    // 2. Inform everyone in the room that the game is ready to start placing
    io.to(roomCode).emit("gameStart");
    // --- END REFACTORED LOGIC ---

    console.log(
      `[Server] Room ${roomCode}: Game start (placement phase). Sent gameStart to clients.`
    );

    io.to(roomCode).emit("placementTimerStarted", PLACEMENT_TIME_LIMIT);
    room.placementTimer = setTimeout(() => {
      console.log(`[Server] Room ${roomCode}: Placement timer ended.`);
      startShootingPhase(roomCode);
    }, PLACEMENT_TIME_LIMIT);
  });

  socket.on("planesPlaced", ({ roomCode, placeBoard }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "placing") {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) {
      return;
    }

    const headCount = placeBoard.flat().filter((cell) => cell === "H").length;
    if (headCount !== PLANES_PER_PLAYER) {
      return socket.emit(
        "error",
        `You must place exactly ${PLANES_PER_PLAYER} planes.`
      );
    }

    player.placeBoard = placeBoard;
    player.ready = true;
    console.log(
      `[Server] Room ${roomCode}: Player ${player.playerIndex} is ready.`
    );

    // Notify the opponent
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit("opponentReady");
    }

    // Check if all players are ready to start the shooting phase early
    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      console.log(
        `[Server] Room ${roomCode}: Both players are ready. Starting shooting phase.`
      );
      startShootingPhase(roomCode);
    }
  });

  socket.on("shoot", ({ roomCode, row, col }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== "shooting") {
      return;
    }

    const shooter = room.players.find((p) => p.id === socket.id);
    if (!shooter || shooter.playerIndex !== room.currentTurnIndex) {
      return; // Not their turn
    }

    const targetPlayer = room.players.find((p) => p.id !== socket.id);
    if (!targetPlayer || !targetPlayer.placeBoard) {
      console.error(
        `[Server] CRITICAL ERROR: Target player or their board is missing.`
      );
      return socket.emit(
        "error",
        "Internal server error: Opponent's board is invalid."
      );
    }

    const currentShotValue = targetPlayer.placeBoard[row][col];
    if (["D", "I", "M"].includes(currentShotValue)) {
      return; // Already shot here
    }

    let result = "M"; // Miss
    if (currentShotValue === "H") {
      result = "D"; // Destroyed (Hit Head)
    } else if (currentShotValue === "B") {
      result = "I"; // Hit Body
    }

    targetPlayer.placeBoard[row][col] = result;

    io.to(roomCode).emit("shotResult", {
      shooterIndex: shooter.playerIndex,
      row,
      col,
      result,
    });

    if (result === "D") {
      const headsLeft = targetPlayer.placeBoard
        .flat()
        .filter((cell) => cell === "H").length;
      if (headsLeft === 0) {
        room.state = "finished";
        io.to(roomCode).emit("gameOver", shooter.playerIndex);
        console.log(
          `[Server] Room ${roomCode}: GAME OVER. Winner: Player ${shooter.playerIndex}`
        );
        delete rooms[roomCode];
        return;
      }
    }

    // Switch turns
    room.currentTurnIndex = (room.currentTurnIndex + 1) % 2;
    io.to(roomCode).emit("newTurn", room.currentTurnIndex);
  });

  socket.on("disconnect", () => {
    console.log(`[Server] User disconnected: ${socket.id}`);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const player = room.players.find((p) => p.id === socket.id);
      if (player) {
        console.log(
          `[Server] Room ${roomCode}: Player ${player.playerIndex} left.`
        );
        io.to(roomCode).emit("opponentLeft");
        if (room.placementTimer) {
          clearTimeout(room.placementTimer);
        }
        delete rooms[roomCode];
        console.log(`[Server] Room ${roomCode} deleted.`);
        return;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Server is running on port ${PORT}`);
});
