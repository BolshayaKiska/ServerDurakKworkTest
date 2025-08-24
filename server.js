const WebSocket = require('ws');

const port = 8080;
const maxPlayers = 6;

const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['6', '7', '8', '9', '10', 'В', 'Д', 'К', 'Т'];

function createDeck() {
  const deck = [];
  suits.forEach(suit => {
    ranks.forEach(rank => {
      deck.push({ suit, rank });
    });
  });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const wss = new WebSocket.Server({ port });
const clients = new Map();

let deck = [];
let gameInProgress = false;
let tableCards = [];
let currentPlayerOrder = [];
let attackerIndex = 0;
let defenderIndex = 1;
let trumpCard = null;
const playersScores = new Map();

console.log(`Server started on port ${port}`);

// Автоматический запуск игры при подключении второго игрока
function tryStartGame() {
  if (clients.size >= 2 && !gameInProgress) {
    startGame();
  }
}

function startGame() {
  deck = createDeck();
  tableCards = [];
  gameInProgress = true;
  playersScores.clear();

  // Раздача карт
  clients.forEach((player, ws) => {
    player.hand = [];
    for (let i=0; i<6; i++) {
      player.hand.push(deck.pop());
    }
    send(ws, { type: 'your_hand', hand: player.hand });
  });

  // Определение козыря
  trumpCard = deck.pop();
  deck.unshift(trumpCard);
  broadcast({ type: 'trump', card: trumpCard });

  // Порядок ходов
  currentPlayerOrder = Array.from(clients.keys());
  attackerIndex = 0;
  defenderIndex = 1;

  // Начать первый ход
  nextTurn();
}

function nextTurn() {
  if (currentPlayerOrder.length < 2) {
    endGame();
    return;
  }
  const attackerWS = currentPlayerOrder[attackerIndex];
  const defenderWS = currentPlayerOrder[defenderIndex];

  send(attackerWS, { type: 'your_turn', role: 'attack' });
  send(defenderWS, { type: 'waiting', message: 'Ждите своей очереди' });
}

function switchRoles() {
  attackerIndex = (attackerIndex + 1) % currentPlayerOrder.length;
  defenderIndex = (defenderIndex + 1) % currentPlayerOrder.length;
  nextTurn();
}

function handleAttack(ws, card) {
  const player = clients.get(ws);
  if (!player.hand.some(c => c.suit === card.suit && c.rank === card.rank)) {
    send(ws, { type: 'error', message: 'У вас нет такой карты' });
    return;
  }
  tableCards.push({ player: ws, card });
  removeCardFromHand(player, card);
  broadcast({ type: 'table_update', cards: getTableCards() });
  switchRoles();
}

function handleDefend(ws, card) {
  const player = clients.get(ws);
  if (!player.hand.some(c => c.suit === card.suit && c.rank === card.rank)) {
    send(ws, { type: 'error', message: 'У вас нет такой карты' });
    return;
  }
  const attackCard = tableCards[0].card;
  if (!canBeat(card, attackCard, trumpCard.suit)) {
    send(ws, { type: 'error', message: 'Эту карту побить нельзя' });
    return;
  }
  tableCards.push({ player: ws, card });
  removeCardFromHand(player, card);
  broadcast({ type: 'table_update', cards: getTableCards() });
  endRound();
}

function canBeat(card, attackCard, trumpSuit) {
  if (card.suit === attackCard.suit && rankValue(card.rank) > rankValue(attackCard.rank)) {
    return true;
  }
  if (card.suit === trumpSuit && attackCard.suit !== trumpSuit) {
    return true;
  }
  return false;
}

function rankValue(rank) {
  const order = ['6','7','8','9','10','В','Д','К','Т'];
  return order.indexOf(rank);
}

function removeCardFromHand(player, card) {
  player.hand = player.hand.filter(c => !(c.suit === card.suit && c.rank === card.rank));
}

function getTableCards() {
  return tableCards.map(tc => tc.card);
}

function endRound() {
  // Подсчет очков
  clients.forEach((player, ws) => {
    if (player.hand.length > 0) {
      let score = playersScores.get(ws) || 0;
      score += 1;
      playersScores.set(ws, score);
    }
  });
  // Отправка итогов
  clients.forEach((player, ws) => {
    send(ws, {
      type: 'round_end',
      scores: Array.from(playersScores.entries()).map(([w, s]) => {
        return { address: w._socket.remoteAddress, score: s };
      }),
      remainingCards: Array.from(clients).map(([w, p]) => ({ address: w._socket.remoteAddress, handCount: p.hand.length })),
      tableCards: getTableCards()
    });
  });
  gameInProgress = false;
  announceWinner();
}

function announceWinner() {
  const minScore = Math.min(...Array.from(playersScores.values()));
  const winners = Array.from(playersScores.entries()).filter(([w, s]) => s === minScore);
  broadcast({ type: 'game_over', winners: winners.map(([w, s]) => ({ address: w._socket.remoteAddress, score: s })) });
}

function endGame() {
  broadcast({ type: 'game_end', message: 'Игра завершена' });
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  clients.forEach((player, ws) => {
    send(ws, data);
  });
}

wss.on('connection', (ws) => {
  if (clients.size >= maxPlayers) {
    send(ws, { type: 'error', message: 'Лимит игроков достигнут' });
    ws.close();
    return;
  }
  clients.set(ws, { hand: [] });
  console.log(`Player connected. Total: ${clients.size}`);
  send(ws, { type: 'welcome', message: 'Добро пожаловать! Подключено игроков: ' + clients.size });

  // Проверка запуска игры
  tryStartGame();

  ws.on('message', (message) => {
    const msg = JSON.parse(message);
    switch (msg.type) {
      case 'start_game':
        if (!gameInProgress && clients.size >= 2) {
          startGame();
        }
        break;
      case 'attack':
        handleAttack(ws, msg.card);
        break;
      case 'defend':
        handleDefend(ws, msg.card);
        break;
      case 'pass':
        switchRoles();
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Player disconnected. Remaining: ${clients.size}`);
    // Можно добавить логику для завершения игры
  });
});
