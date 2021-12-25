const winston = require('winston');

const {
  combine,
  timestamp,
  simple,
  splat,
} = winston.format;

require('winston-daily-rotate-file');

const transport = new winston.transports.DailyRotateFile({
  filename: 'log/application-%DATE%.log',
  datePattern: 'YYYY-MM-DD-HH',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
});

const logger = winston.createLogger({
  level: 'info',
  format: combine(
    timestamp(),
    splat(),
    simple(),
  ),
  transports: [
    new winston.transports.File({
      filename: 'error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'debug.log',
      level: 'debug',
    }),
    transport,
  ],
});

const { WSv2 } = require('bitfinex-api-node');
const { Order, Wallet } = require('bfx-api-node-models');
const debug = require('debug')('btx-order');
const wdDebug = require('debug')('ws');

// const secret = require('./config/secret.json');
// const gridSetup = require('./config/grid_setup.json');

// Test setting
const gridSetup = require('./config/test_grid_setup.json');
const secret = require('./config/test_secret.json');

const orderQueue = [];
debug.enabled = true;
wdDebug.enabled = true;

let ws;
/**
 * 第一次設定，當還沒跑完第一次設定時跳過餘額不足時，將 order 放到 orderQueue 的步驟。
 */
const {
  max, min, fixedPoint, weight, amount, symbol,
} = gridSetup;
const tags = [];
let lastPrice = min;
let lastMidPrice = -1;
const gridOrders = {};

let leftWallet = new Wallet({
  currency: 'IOT',
  balanceAvailable: 0,
});// IOTA

let rightWallet = new Wallet({
  currency: 'USD',
  balanceAvailable: 0,
});// USD

const { apiKey, apiSecret } = secret;

tags.push(lastPrice);
do {
  lastPrice += (lastPrice * weight);
  tags.push(lastPrice.toFixed(fixedPoint));
} while (lastPrice < max);

debug('[Setup] tags', tags);
logger.log('info', '[Setup] tags %s', tags);

async function submitOrder(order) {
  if (!order) {
    return;
  }

  order.registerListeners(ws);

  debug('new order: %s', order.toString());

  await new Promise((resolve) => {
    order.once('update', (newOrder) => {
      debug('new order first update: id: %s, cid: %s => %s', newOrder.id, newOrder.cid, newOrder.toString());
      resolve();
    });
    order.submit();
  });

  gridOrders[order.id] = true;

  debug('order list: %s', Object.keys(gridOrders));
}

let cidIndex = 0;

// 買
async function newBidOrder(bidSymbol, price, bidAmount) {
  if (!bidSymbol || !price || !bidAmount) {
    debug('newBidOrder invalid input: symbol=%s, price=%s, amount=%s', bidSymbol, price, bidAmount);
    logger.log('info', '[%s] invalid input: symbol=%s, price=%s, amount=%s', 'newBidOrder', bidSymbol, price, bidAmount);
    return;
  }
  cidIndex += 1;
  const order = new Order({
    cid: cidIndex,
    symbol,
    price,
    amount,
    type: Order.type.EXCHANGE_LIMIT,
  });

  debug('newBidOrder.', rightWallet.balanceAvailable, amount * price);

  if (rightWallet.balanceAvailable >= amount * price) {
    await submitOrder(order);
  } else {
    // debug('Add order to orderQueue. %j', orderQueue);
    logger.log('info', '[newBidOrder] Add order to orderQueue.');
    orderQueue.push(order);
    logger.log('info', '[newBidOrder] orderQueue. %j', order);
  }
}

// 賣
async function newAskOrder(askSymbol, price, askAmount) {
  if (!askSymbol || !price || !askAmount) {
    debug('newAskOrder invalid input: symbol=%s, price=%s, amount=%s', askSymbol, price, askAmount);
    logger.log('info', '[newAskOrder] invalid input: symbol=%s, price=%s, amount=%s', askSymbol, price, askAmount);
    return;
  }

  cidIndex += 1;
  const order = new Order({
    cid: cidIndex,
    symbol,
    price,
    amount: -amount,
    type: Order.type.EXCHANGE_LIMIT,
  });

  debug('newAskOrder.', leftWallet.balanceAvailable, amount);
  if (leftWallet.balanceAvailable >= amount) {
    await submitOrder(order);
  } else {
    // debug('Add order to orderQueue.', orderQueue);
    logger.log('info', '[newAskOrder] Add order to orderQueue.');
    logger.log('info', '[newAskOrder] orderQueue. %j', order);
    orderQueue.push(order);
  }
}

async function updateOrder(orderSymbol) {
  const bids = tags.filter((price) => price < lastMidPrice).reverse();
  const asks = tags.filter((price) => price > lastMidPrice);
  debug('-------------updateOrder-------------');
  debug('[updateOrder] lastMidPrice: %s, bid: %s, ask: %s', lastMidPrice, bids, asks);
  logger.log('info', '[updateOrder] -------------updateOrder-------------');
  logger.log('info', '[updateOrder] lastMidPrice: %s, bid: %s, ask: %s', lastMidPrice, bids, asks);
  const maxLength = Math.max(bids.length, asks.length);

  const orders = [];
  try {
    for (let i = 0; i < maxLength; i += 1) {
      orders.push(
        newAskOrder(orderSymbol, asks[i], amount),
        newBidOrder(orderSymbol, bids[i], amount),
      );
    }

    await Promise.all(orders);
  } catch (e) {
    // ignore
  }

  debug('==============updateOrder=============');
  logger.log('info', '[updateOrder] ==============updateOrder=============');
}

async function subscribeTicker(tickerSymbol) {
  return new Promise((resolve) => {
    ws.onTicker({ tickerSymbol }, (ticker) => {
      debug(`${symbol} ticker: %j`, ticker.toJS());
      logger.log('info', '[subscribeTicker] ticker: %j', ticker.toJS());
      lastMidPrice = ticker.toJS().lastPrice;
      updateOrder(symbol);
      ws.unsubscribeTicker(symbol);
      debug('Init order complete.');
      logger.log('info', '[Init] Init order complete');
      resolve();
    });

    ws.subscribeTicker(tickerSymbol);
  });
}

// eslint-disable-next-line no-unused-vars
async function subscribeOrderBook(orderSymbol) {
  let midPrice;
  // 'ob' is a full OrderBook instance, with sorted arrays 'bids' & 'asks'
  ws.onOrderBook({ orderSymbol }, (ob) => {
    midPrice = ob.midPrice();

    if (midPrice !== lastMidPrice) {
      debug(
        'BTCUSD mid price: %d (bid: %d, ask: %d)',
        midPrice,
        ob.bids[0][0],
        ob.asks[0][0],
      );
      logger.log(
        'info',
        '[subscribeOrderBook] %s: %s %s %s',
        orderSymbol,
        midPrice,
        ob.bids[0][0],
        ob.asks[0][0],
      );
    }

    lastMidPrice = midPrice;
    updateOrder();
  });

  await ws.subscribeOrderBook(orderSymbol);
}

async function subscribeTrades(tradeSymbol) {
  ws.onTradeEntry({ symbol: tradeSymbol }, (trade) => {
    debug('trade on %s: %s', symbol, trade.toString());
    // logger.log('info', '[subscribeTrades] trade on %s: %s', symbol, trade.toString());
  });

  await ws.subscribeTrades(tradeSymbol);
}

async function cancelAllOrder(orderSymbol) {
  debug('cancelAllOrder');
  logger.log('info', '[cancelAllOrder] orderSymbol: %s', orderSymbol);
  const allOrders = await new Promise((resolve) => {
    ws.onOrderSnapshot({}, resolve);
  });
  allOrders.forEach((order) => {
    debug('cancel order:%s %s %s', order.id, order.orderSymbol, order);
  });
  const filterOrders = allOrders.filter((order) => order.symbol === orderSymbol);
  await ws.cancelOrders(filterOrders);
}

async function subscribeCandles(candleSymbol) {
  const candleKey = `trade:1h:${candleSymbol}`;
  ws.onCandle({ key: candleKey }, (candles) => {
    debug('candle:', candles[0]);
    ws.onWalletSnapshot({}, () => {
      console.log('empty onWalletSnapshot');
    });
  });
  await ws.subscribeCandles(candleKey);
}

async function submitOrderQueue() {
  const order = orderQueue.shift();

  await submitOrder(order);
  debug(order.status);
  if (!order.status) {
    debug('Order failure put order back.');
    logger.log('info', '[Wallet Update] Order failure put order back.');
    orderQueue.unshift(order);
  } else {
    debug('Order submit!!!');
    logger.log('info', '[Wallet Update] Order submit!!!');
  }
}

async function execute() {
  logger.log('info', '======execute=======');

  await ws.auth();

  ws.onWalletSnapshot({}, (wallets) => {
    wallets
      .filter((wallet) => wallet.type === 'exchange')
      .forEach((wallet) => {
        debug('wallet %s %s %s', wallet.type, wallet.currency, wallet.balance);
        logger.log('info', '[Wallet Snapshot] %s %s %s', wallet.type, wallet.currency, wallet.balance);
        switch (wallet.currency) {
          case leftWallet.currency:
            leftWallet = wallet;
            break;
          case rightWallet.currency:
            rightWallet = wallet;
            break;
          default:
        }
      });
  });
  // 在下完第一次訂號後才監測餘額
  ws.onWalletUpdate({}, async (wallet) => {
    if (wallet.type !== 'exchange') {
      return;
    }

    debug('wallet update %s %s %s', wallet.type, wallet.currency, wallet.balanceAvailable);
    logger.log('info', '[Wallet Update] %s %s %s', wallet.type, wallet.currency, wallet.balance);
    switch (wallet.currency) {
      case leftWallet.currency:
        leftWallet = wallet;
        break;
      case rightWallet.currency:
        rightWallet = wallet;
        break;
      default:
    }

    if (orderQueue.length === 0) {
      debug('No order in queue.');
      logger.log('info', '[Wallet Update] No order in queue.');
      Promise.resolve();
      return;
    }

    submitOrderQueue();
  });

  ws.onOrderUpdate({ symbol }, (order) => {
    debug('updated: %s', order.toString());
    logger.log('info', '[Order Update] %s', order.toString());
  });

  ws.onOrderClose({ symbol }, (order) => {
    debug('order closed: %s, priceAvg: %s, amountOrig: %s, amount: %s, status: %s', order.id, order.priceAvg, order.amountOrig, order.amount, order.status);
    logger.log('info', '[Order closed] %s, priceAvg: %s, amountOrig: %s, amount: %s, status: %s', order.id, order.priceAvg, order.amountOrig, order.amount, order.status);
    if (order.status.indexOf(Order.status.EXECUTED)) {
      return;
    }

    if (!gridOrders[order.id]) {
      debug('Not grid order');
      // return;
    }

    delete gridOrders[order.id];

    debug('Number(order.amountOrig): %s', Number(order.amountOrig));
    // negative number = ask, reverse action bid => ask, ask => bid
    const weightPrice = order.price * weight;
    if (Number(order.amountOrig) < 0) {
      newBidOrder(order.symbol, order.price - weightPrice, order.amountOrig);
    } else {
      newAskOrder(order.symbol, order.price + weightPrice, order.amountOrig);
      // order.amount
    }
  });

  // await subscribeCandles(symbol);
  // await cancelAllOrder(symbol);
  // await subscribeTrades(symbol);
  // await subscribeTicker(symbol);
  // await submitOrderQueue();
}

async function ping() {
  debug('[ping]');

  ws.send({
    event: 'ping',
    cid: Date.now(),
  });
}

ws = new WSv2({
  apiKey,
  apiSecret,
  transform: true,
  manageOrderBooks: true, // tell the ws client to maintain full sorted OBs
  // autoReconnect: true,
});

ws.on('error', (e) => {
  debug('WSv2 error: %s', e.message || e);
  logger.log('error', e.message || e);
});

ws.on('open', () => {
  debug('WSv2 opened......');
  logger.log('info', 'WSv2 opened......');
  execute();
  setTimeout(() => ping(), 10000);
});

ws.on('close', () => {
  debug('WSv2 close.');
  logger.log('info', '======WSv2 close=======');
  setTimeout(() => ws.open(), 1000);
});

ws.on('pong', (msg) => {
  debug('[pong]', msg);
});

ws.open();

ws._ws.on('message', (msg) => {
  logger.log('info', '[onMessage]', msg);
});

// execute();
// setTimeout(() => ws.close(), 20 * 1000);
