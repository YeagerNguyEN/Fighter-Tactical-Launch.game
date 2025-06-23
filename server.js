// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Cho phép tất cả các tên miền, an toàn cho Render
    methods: ["GET", "POST"],
  },
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
const PLACEMENT_TIME_LIMIT = 30000; // 30 giây
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
    // Check bounds and if cell is already occupied
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== 0) {
      return false;
    }
  }
  return true;
}

function placePlaneOnBoard(board, headRow, headCol, shape) {
  // Head is the first element in BASE_PLANE_SHAPE (0,0) relative to itself
  board[headRow + shape[0][1]][headCol + shape[0][0]] = "H"; // Place head
  for (let i = 1; i < shape.length; i++) {
    const [dx, dy] = shape[i];
    board[headRow + dy][headCol + dx] = "B"; // Place body parts
  }
}

// Function to generate a random valid placeBoard for a player
function generateRandomPlaceBoard() {
  let board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
  let planesPlaced = 0;

  while (planesPlaced < PLANES_PER_PLAYER) {
    const randomRow = Math.floor(Math.random() * ROWS);
    const randomCol = Math.floor(Math.random() * COLS);
    const randomDirection =
      DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
    const shape = getRotatedShape(randomDirection);

    if (canPlacePlane(board, randomRow, randomCol, shape)) {
      placePlaneOnBoard(board, randomRow, randomCol, shape);
      planesPlaced++;
    }
  }
  return board;
}
// --- END HELPER FUNCTIONS ---

const startShootingPhase = (roomCode) => {
  const room = rooms[roomCode];
  console.log(`[Server] Calling startShootingPhase for room ${roomCode}`);
  console.log(
    `[Server] Room state before phase change check: ${
      room ? room.state : "N/A"
    }`
  );

  if (!room || room.state !== "placing") {
    console.log(
      `[Server] startShootingPhase: Room ${roomCode} is not in 'placing' state or does not exist. Aborting.`
    );
    return;
  }

  if (room.placementTimer) {
    clearTimeout(room.placementTimer);
    room.placementTimer = null;
    console.log(
      `[Server] startShootingPhase: Cleared placement timer for room ${roomCode}.`
    );
  }

  // --- NEW LOGIC: Ensure all players have a placeBoard ---
  room.players.forEach((player) => {
    if (!player.ready || !player.placeBoard) {
      // If player is not ready or their placeBoard is null, generate one for them
      player.placeBoard = generateRandomPlaceBoard();
      player.ready = true; // Mark as ready after generating board
      console.log(
        `[Server] Player ${player.playerIndex} (${player.id}) did not submit placeBoard. Generated random board for them.`
      );
    }
  });
  // --- END NEW LOGIC ---

  room.state = "shooting";
  io.to(roomCode).emit("shootingPhaseStart");
  io.to(roomCode).emit("newTurn", room.currentTurnIndex);

  console.log(
    `[Server] Phòng ${roomCode}: BẮT ĐẦU BẮN. Lượt của người chơi ${room.currentTurnIndex}.`
  );
};

io.on("connection", (socket) => {
  console.log(`[Server] Người dùng đã kết nối: ${socket.id}`);

  socket.on("createRoom", () => {
    let roomCode;
    do {
      roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    } while (rooms[roomCode]);

    rooms[roomCode] = {
      players: [
        { id: socket.id, playerIndex: 0, ready: false, placeBoard: null },
      ],
      state: "waiting", // Initial state
      currentTurnIndex: 0,
    };

    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
    console.log(`[Server] Phòng ${roomCode} đã được tạo bởi ${socket.id}`);
  });

  socket.on("joinRoom", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) {
      console.log(
        `[Server] Lỗi: ${socket.id} thử tham gia phòng ${roomCode} không tồn tại.`
      );
      return socket.emit("error", "Phòng không tồn tại.");
    }
    if (room.players.length >= 2) {
      console.log(
        `[Server] Lỗi: ${socket.id} thử tham gia phòng ${roomCode} đã đầy.`
      );
      return socket.emit("error", "Phòng đã đầy.");
    }

    socket.join(roomCode);
    room.players.push({
      id: socket.id,
      playerIndex: 1,
      ready: false,
      placeBoard: null, // Mặc định là null
    });
    room.state = "placing"; // Room state changes to placing once 2 players are in
    console.log(
      `[Server] ${socket.id} đã tham gia phòng ${roomCode}. Trạng thái phòng: ${room.state}`
    );

    const playerInfo = room.players.map((p) => ({
      id: p.id,
      playerIndex: p.playerIndex,
    }));
    // --- Cập nhật ở đây: Gửi roomCode và playerIndex cho từng client ---
    room.players.forEach((p) => {
      io.to(p.id).emit("gameStart", {
        roomCode,
        playerIndex: p.playerIndex,
        players: playerInfo,
      });
    });
    console.log(
      `[Server] Phòng ${roomCode}: Trò chơi bắt đầu (giai đoạn đặt). Gửi thông tin gameStart cho client.`
    );

    io.to(roomCode).emit("placementTimerStarted", PLACEMENT_TIME_LIMIT);
    console.log(
      `[Server] Phòng ${roomCode}: Bắt đầu đếm ngược đặt máy bay (${
        PLACEMENT_TIME_LIMIT / 1000
      }s).`
    );
    room.placementTimer = setTimeout(() => {
      console.log(
        `[Server] Phòng ${roomCode}: Hết giờ đặt máy bay (tự động chuyển giai đoạn).`
      );
      startShootingPhase(roomCode);
    }, PLACEMENT_TIME_LIMIT);
  });

  socket.on("planesPlaced", ({ roomCode, placeBoard }) => {
    const room = rooms[roomCode];
    console.log(
      `[Server] planesPlaced received from ${
        socket.id
      } for room ${roomCode}. Room state: ${room ? room.state : "N/A"}`
    );

    if (!room || room.state !== "placing") {
      console.log(
        `[Server] planesPlaced: Room ${roomCode} is not in 'placing' state or does not exist. Aborting.`
      );
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) {
      console.log(
        `[Server] planesPlaced: Player ${socket.id} not found in room ${roomCode}. Aborting.`
      );
      return;
    }

    const headCount = placeBoard.flat().filter((cell) => cell === "H").length;
    if (headCount !== 3) {
      console.log(
        `[Server] planesPlaced: Player ${socket.id} submitted ${headCount} heads instead of 3. Sending error.`
      );
      return socket.emit("error", `Bạn phải đặt đúng 3 máy bay.`);
    }

    player.placeBoard = placeBoard;
    player.ready = true;
    console.log(
      `[Server] Phòng ${roomCode}: Người chơi ${player.playerIndex} đã sẵn sàng. ready: ${player.ready}`
    );

    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit("opponentReady");
      console.log(
        `[Server] Phòng ${roomCode}: Thông báo opponentReady tới ${opponent.id}. Đối thủ ready: ${opponent.ready}.`
      );
    }

    if (room.players.every((p) => p.ready)) {
      console.log(
        `[Server] Phòng ${roomCode}: CẢ HAI người chơi đã sẵn sàng. Gọi startShootingPhase.`
      );
      startShootingPhase(roomCode);
    } else {
      console.log(`[Server] Phòng ${roomCode}: Chưa đủ người chơi sẵn sàng.`);
    }
  });

  socket.on("shoot", ({ roomCode, row, col }) => {
    const room = rooms[roomCode];
    console.log(
      `[Server] Shoot request from ${socket.id} for room ${roomCode} at [${row}, ${col}].`
    );
    console.log(`[Server] Current Room state: ${room ? room.state : "N/A"}.`);

    if (!room || room.state !== "shooting") {
      console.log(
        `[Server] Shoot failed for ${socket.id}: Room ${roomCode} not found or not in 'shooting' phase.`
      );
      return;
    }

    const shooter = room.players.find((p) => p.id === socket.id);
    if (!shooter || shooter.playerIndex !== room.currentTurnIndex) {
      console.log(
        `[Server] Shoot failed for ${
          socket.id
        }: Not their turn (current turn: ${room.currentTurnIndex}, shooter: ${
          shooter ? shooter.playerIndex : "N/A"
        }).`
      );
      return;
    }

    const targetPlayer = room.players.find((p) => p.id !== socket.id);
    if (!targetPlayer) {
      console.log(
        `[Server] Shoot failed for ${socket.id}: Target player not found in room.`
      );
      return;
    }

    if (!targetPlayer.placeBoard) {
      console.error(
        `[Server] CRITICAL ERROR: Target player (${targetPlayer.id}) placeBoard is NULL at SHOOT phase! This should not happen.`
      );
      socket.emit("error", "Lỗi nội bộ server: Bảng đối thủ không hợp lệ.");
      return;
    }

    const currentShotValue = targetPlayer.placeBoard[row][col];
    console.log(
      `[Server] Target cell [${row}, ${col}] current value: ${currentShotValue}.`
    );

    if (["D", "I", "M"].includes(currentShotValue)) {
      console.log(
        `[Server] Shoot failed for ${socket.id}: Cell [${row}, ${col}] already shot.`
      );
      return;
    }

    let result = "M"; // Miss (Trượt)
    if (currentShotValue === "H") {
      result = "D"; // Destroyed (Phá hủy đầu)
    } else if (currentShotValue === "B") {
      result = "I"; // Hit Body (Trúng thân)
    }

    targetPlayer.placeBoard[row][col] = result;
    console.log(
      `[Server] Shot result for ${socket.id} at [${row}, ${col}]: ${result}.`
    );

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
      console.log(
        `[Server] Player ${targetPlayer.playerIndex} heads left: ${headsLeft}`
      );
      if (headsLeft === 0) {
        room.state = "finished";
        io.to(roomCode).emit("gameOver", shooter.playerIndex);
        console.log(
          `[Server] Phòng ${roomCode}: TRÒ CHƠI KẾT THÚC. Thắng: ${shooter.playerIndex}`
        );
        delete rooms[roomCode];
        return;
      }
    }

    room.currentTurnIndex = (room.currentTurnIndex + 1) % 2;
    io.to(roomCode).emit("newTurn", room.currentTurnIndex);
    console.log(
      `[Server] Phòng ${roomCode}: Chuyển lượt. Lượt tiếp theo: ${room.currentTurnIndex}.`
    );
  });

  socket.on("disconnect", () => {
    console.log(`[Server] Người dùng đã ngắt kết nối: ${socket.id}`);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      if (room && room.players) {
        const playerIndex = room.players.findIndex((p) => p.id === socket.id);

        if (playerIndex !== -1) {
          console.log(
            `[Server] Phòng ${roomCode}: Người chơi ${socket.id} thoát.`
          );
          io.to(roomCode).emit("opponentLeft");
          if (room.placementTimer) {
            clearTimeout(room.placementTimer);
            room.placementTimer = null;
            console.log(
              `[Server] Phòng ${roomCode}: Đã xóa placement timer do người chơi thoát.`
            );
          }
          delete rooms[roomCode];
          console.log(`[Server] Đã xóa phòng ${roomCode} do người chơi thoát.`);
          return;
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Server đang chạy trên cổng ${PORT}`);
});
