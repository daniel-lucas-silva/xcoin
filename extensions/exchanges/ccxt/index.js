const ccxt = require('ccxt')
const path = require('path')
const fs = require('fs')
const _ = require('lodash')
const colors = require('colors')
const tb = require('timebucket')
const HttpsProxyAgent = require('https-proxy-agent')
const filterSymbols = require('../../../lib/filter-symbol')

function CcxtConnector(conf, so, options) {
  this.conf = conf
  this.so = so
  this.options = Object.assign(
    {
      adjustForTimeDifference: true
    },
    options || {}
  )
  this.exchagneId = so.exchange
  this.public_client = null
  this.authed_client = null
  this.watch_client = null
  this.orders = {}

  this.so.symbols = this.updateSymbols(this.so.symbols)
}

CcxtConnector.prototype.publicClient = function () {
  if (!this.public_client) {
    this.public_client = new ccxt[this.exchagneId]({
      apiKey: '',
      secret: '',
      options: this.options
    })
    this.setProxy(this.public_client)
  }
  return this.public_client
}

CcxtConnector.prototype.watchClient = function () {
  if (!this.watch_client) {
    this.watch_client = new ccxt.pro[this.exchagneId]({
      apiKey: '',
      secret: '',
      options: this.options
    })
    this.setProxy(this.watch_client)
  }
  return this.watch_client
}

CcxtConnector.prototype.authedClient = function () {
  if (!this.authed_client) {
    const keys = this.conf.secret.keys[this.exchagneId]
    if (!keys || !keys.key || keys.key === 'YOUR-API-KEY') {
      throw new Error('bot.noExchangeCredentialsError')
    }
    this.authed_client = new ccxt[this.exchagneId]({
      apiKey: keys.key,
      secret: keys.secret,
      options: this.options,
      enableRateLimit: true
    })
    this.setProxy(this.authed_client)
  }
  return this.authed_client
}

CcxtConnector.prototype.setProxy = function (client) {
  if (this.so.proxy) {
    const agent = HttpsProxyAgent(this.so.proxy)
    client.agent = agent
  }
}

CcxtConnector.prototype.joinProduct = function (product_id) {
  const split = product_id.split('-')
  return split.length > 1 ? `${split[0]}/${split[1]}` : product_id
}

CcxtConnector.prototype.retry = function (method, args, err) {
  if (
    method !== 'getTrades' &&
    method !== 'getKLines' &&
    method !== 'getTickers'
  ) {
    console.error(
      `\nretry ${this.exchagneId} API is down! unable to call ${method}, retrying in 20s`
        .red
    )
    if (err) console.error(err)
    console.error(args.slice(0, -1))
  }
  setTimeout(() => {
    this[method].apply(this, args)
  }, 20000)
}

CcxtConnector.prototype.refreshProducts = function (cb, force = true) {
  if (!force) {
    return cb(this.getProducts())
  }
  const client = this.publicClient()
  const getFullNum = (num) => {
    if (isNaN(num)) return num
    if (_.isInteger(num)) return num === 0 ? 1 : `0.${'0'.repeat(num - 1)}1`
    const str = `${num}`
    return !/e/i.test(str) ? num : num.toFixed(18).replace(/0+$/, '')
  }
  client.fetchMarkets().then((markets) => {
    const products = markets.map((market) => ({
      id: market.id,
      asset: market.base,
      currency: market.quote,
      active: market.active,
      maker: market.maker,
      taker: market.taker,
      min_size: getFullNum(
        market.limits.amount.min || market.precision.amount
      ).toString(),
      increment: getFullNum(market.precision.price).toString(),
      asset_increment: getFullNum(market.precision.amount).toString(),
      label: `${market.base}/${market.quote}`,
      exchagne_id: this.exchagneId,
      product_id: `${market.base}-${market.quote}`,
      normalized: `${this.exchagneId}.${market.base}-${market.quote}`
    }))
    filterSymbols(
      this,
      products,
      {
        currency: this.conf.product_currency,
        without_margin: this.conf.product_without_margin,
        min_volume: this.conf.product_min_volume,
        active: this.conf.product_active
      },
      (filtered) => {
        const target = path.resolve(
          __dirname,
          `../../../data/exchanges/${this.exchagneId}_products.json`
        )
        fs.writeFileSync(target, JSON.stringify(filtered, null, 2))
        if (cb) cb(filtered)
      }
    )
  })
}

CcxtConnector.prototype.getProducts = function () {
  try {
    return require(`../../../data/exchanges/${this.exchagneId}_products.json`)
  } catch (e) {
    return []
  }
}

CcxtConnector.prototype.getTrades = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.publicClient()
  let startTime = opts.from || parseInt(opts.to, 10) - 3600000
  const args = opts.from ? {} : { endTime: opts.to }
  const symbol = this.joinProduct(opts.product_id)
  if (opts.last_trade_id) {
    args.fromId = opts.last_trade_id
    args.fetchTradesMethod = 'publicGetHistoricalTrades'
    client
      .fetchTrades(symbol, undefined, undefined, args)
      .then((result) => {
        const trades = result.map((trade) => ({
          trade_id: trade.id,
          time: trade.timestamp,
          size: parseFloat(trade.amount),
          price: parseFloat(trade.price),
          side: trade.side
        }))
        cb(null, trades)
      })
      .catch((error) => {
        console.error('An error occurred', error)
        return this.retry('getTrades', func_args)
      })
  } else {
    client
      .fetchTrades(symbol, startTime, undefined, {
        fetchTradesMethod: 'publicGetAggTrades'
      })
      .then((result) => {
        if (!result || !result.length) {
          cb(cb(null, []))
          return
        }
        args.fromId = result[0].id
        args.fetchTradesMethod = 'publicGetHistoricalTrades'
        client
          .fetchTrades(symbol, undefined, undefined, args)
          .then((result) => {
            const trades = result.map((trade) => ({
              trade_id: trade.id,
              time: trade.timestamp,
              size: parseFloat(trade.amount),
              price: parseFloat(trade.price),
              side: trade.side
            }))
            cb(null, trades)
          })
          .catch((error) => {
            console.error('An error occurred', error)
            return this.retry('getTrades', func_args)
          })
      })
  }
}

CcxtConnector.prototype.getKLines = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.publicClient()
  const startTime = opts.from || undefined
  const symbol = this.joinProduct(opts.product_id)
  const args = {}
  client
    .fetchOHLCV(symbol, opts.period, startTime, opts.limit, args)
    .then((result) => {
      const klines = result.map((kline) => {
        let d = tb(kline[0]).resize(opts.period)
        let de = tb(kline[0]).resize(opts.period).add(1)
        return {
          period_id: d.toString(),
          time: d.toMilliseconds(),
          size: opts.period,
          close_time: de.toMilliseconds() - 1,
          open: kline[1],
          high: kline[2],
          low: kline[3],
          close: kline[4],
          volume: kline[5]
        }
      })
      cb(null, klines)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      if (
        error.name &&
        error.name.match(/BadSymbol|InvalidOrder|InsufficientFunds|BadRequest/)
      ) {
        return cb(error.name, {
          status: 'rejected',
          reject_reason: error.name
        })
      }
      return this.retry('getKLines', func_args)
    })
}

CcxtConnector.prototype.getBalance = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  client
    .fetchBalance()
    .then((result) => {
      const balance = { asset: 0, currency: 0 }
      if (this.so.future) {
        Object.keys(result).forEach((key) => {
          if (key === opts.currency) {
            balance.currency = result[key].free + result[key].used
            balance.currency_hold = result[key].used
          }
        })
        result.info.positions.forEach((market) => {
          if (
            opts.position_side &&
            market.positionSide === opts.position_side
          ) {
            if (
              market.symbol === opts.asset + opts.currency &&
              market.positionSide === opts.position_side
            ) {
              balance.asset = Math.abs(market.positionAmt)
              balance.unrealizedProfit = market.unrealizedProfit
              balance.leverage = market.leverage
              balance.isolated = market.isolated
              balance.positionSide = market.positionSide
              balance.entryPrice = market.entryPrice
              balance.asset_hold = 0
            }
            if (!balance.assets) balance.assets = {}
            if (market.positionAmt != 0) {
              balance.assets[market.symbol.replace(opts.currency, '')] = {
                asset: Math.abs(market.positionAmt),
                unrealizedProfit: market.unrealizedProfit,
                leverage: market.leverage,
                isolated: market.isolated,
                positionSide: market.positionSide,
                entryPrice: market.entryPrice,
                asset_hold: 0
              }
            }
          }
        })
      } else {
        Object.keys(result).forEach((key) => {
          if (key === opts.currency) {
            balance.currency = result[key].free + result[key].used
            balance.currency_hold = result[key].used
          } else {
            const num = result[key].free + result[key].used
            if (num > 0) {
              if (!balance.assets) balance.assets = {}
              balance.assets[key] = {
                asset: num,
                asset_hold: result[key].used
              }
            }
            if (key === opts.asset) {
              balance.asset = result[key].free + result[key].used
              balance.asset_hold = result[key].used
            }
          }
        })
      }
      cb(null, balance)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      return this.retry('getBalance', func_args)
    })
}

CcxtConnector.prototype.getQuote = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.publicClient()
  const symbol = this.joinProduct(opts.product_id)
  if (client.has['fetchBidsAsks']) {
    client
      .fetchBidsAsks([symbol])
      .then((result) => {
        const res = result[Object.keys(result)[0]]
        cb(null, { bid: res.bid, ask: res.ask })
      })
      .catch((error) => {
        console.error('An error occurred', error)
        return this.retry('getQuote', func_args)
      })
  } else {
    client
      .fetchTicker(symbol)
      .then((result) => {
        cb(null, {
          bid: result.bid || result.close,
          ask: result.ask || result.close
        })
      })
      .catch((error) => {
        console.error('An error occurred', error)
        return this.retry('getQuote', func_args)
      })
  }
}

CcxtConnector.prototype.getTickers = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.publicClient()
  const symbols =
    opts &&
    opts.symbols &&
    opts.symbols.map((s) => this.joinProduct(s.product_id))
  client
    .fetchTickers(symbols)
    .then((result) => {
      Object.keys(result).forEach((r) => {
        result[r].normalized =
          `${this.options.defaultType === 'future' ? this.exchagneId + 'future.' : this.exchagneId + '.'}${result[r].symbol.replace('/', '-')}`
        result[r].timestamp = result[r].timestamp || new Date().getTime()
      })
      cb(null, result)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      if (
        error.name &&
        error.name.match(/BadSymbol|InvalidOrder|InsufficientFunds|BadRequest/)
      ) {
        return cb(error.name, {
          status: 'rejected',
          reject_reason: error.name
        })
      }
      return this.retry('getTickers', func_args)
    })
}

CcxtConnector.prototype.watchTickers = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.watchClient()
  if (!client.has['watchTicker']) {
    console.log(client.id, 'does not support watchTicker yet')
    return
  }
  const symbols =
    opts &&
    opts.symbols &&
    opts.symbols.map((s) => this.joinProduct(s.product_id))
  client
    .watchTickers(symbols)
    .then((result) => {
      Object.keys(result).forEach((r) => {
        result[r].normalized =
          `${this.options.defaultType === 'future' ? this.exchagneId + 'future.' : this.exchagneId + '.'}${result[r].symbol.replace('/', '-')}`
        result[r].timestamp = result[r].timestamp || new Date().getTime()
      })
      cb(null, result)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      if (
        error.name &&
        error.name.match(/BadSymbol|InvalidOrder|InsufficientFunds|BadRequest/)
      ) {
        return cb(error.name, {
          status: 'rejected',
          reject_reason: error.name
        })
      }
      return this.retry('getTickers', func_args)
    })
}

CcxtConnector.prototype.getDepth = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.publicClient()
  client
    .fetchOrderBook(this.joinProduct(opts.product_id), { limit: opts.limit })
    .then((result) => {
      cb(null, result)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      return this.retry('getDepth', func_args)
    })
}

CcxtConnector.prototype.cancelOrder = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  client.cancelOrder(opts.order_id, this.joinProduct(opts.product_id)).then(
    (body) => {
      if (
        body &&
        (body.message === 'Order already done' ||
          body.message === 'order not found')
      )
        return cb(body)
      cb(body)
    },
    (err) => {
      if (err && err.message && err.message.match(/-2011|UNKNOWN_ORDER/)) {
        console.error(
          `\ncancelOrder retry - unknown Order: ${JSON.stringify(opts)} - ${err}`
            .cyan
        )
      } else {
        return this.retry('cancelOrder', func_args, err)
      }
      cb(null, err)
    }
  )
}

CcxtConnector.prototype.buy = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  if (typeof opts.post_only === 'undefined') {
    opts.post_only = true
  }
  opts.type = 'limit'
  const args = {}
  if (opts.order_type === 'taker') {
    delete opts.post_only
    delete opts.price
    opts.type = 'market'
  } else {
    args.timeInForce = 'GTC'
    args.postOnly = opts.post_only
  }
  if (!client.has.createMarketOrder) {
    opts.type = 'limit'
  }
  opts.side = 'buy'
  delete opts.order_type
  if (this.so.future) {
    args.positionSide = opts.position_side || 'LONG'
    if (args.positionSide === 'SHORT') {
      opts.side = 'sell'
    }
  }
  client
    .createOrder(
      this.joinProduct(opts.product_id),
      opts.type,
      opts.side,
      this.roundToNearest(opts.size, opts),
      opts.price,
      args
    )
    .then((result) => {
      if (result && result.message === 'Insufficient funds') {
        return cb(null, {
          status: 'rejected',
          reject_reason: 'balance'
        })
      }
      const order = {
        id: result ? result.id : null,
        status: 'open',
        price: result.average,
        size: this.roundToNearest(opts.size, opts),
        post_only: !!opts.post_only,
        created_at: new Date().getTime(),
        filled_size: '0',
        order_type: opts.type === 'limit' ? 'maker' : 'taker'
      }
      this.orders['~' + result.id] = order
      cb(null, order)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      if (
        error.name &&
        error.name.match(/InvalidOrder|InsufficientFunds|BadRequest/)
      ) {
        return cb(null, {
          status: 'rejected',
          reject_reason: error.name
        })
      }
      if (error.message.match(/-1013|MIN_NOTIONAL|-2010/)) {
        return cb(null, {
          status: 'rejected',
          reject_reason: 'balance'
        })
      }
      return this.retry('buy', func_args)
    })
}

CcxtConnector.prototype.sell = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  if (typeof opts.post_only === 'undefined') {
    opts.post_only = true
  }
  opts.type = 'limit'
  const args = {}
  if (opts.order_type === 'taker') {
    delete opts.post_only
    delete opts.price
    opts.type = 'market'
  } else {
    args.timeInForce = 'GTC'
    args.postOnly = opts.post_only
  }
  if (!client.has.createMarketOrder) {
    opts.type = 'limit'
  }
  opts.side = 'sell'
  if (this.so.future) {
    args.positionSide = opts.position_side || 'LONG'
    if (args.positionSide === 'SHORT') {
      opts.side = 'buy'
    }
  }
  delete opts.order_type
  client
    .createOrder(
      this.joinProduct(opts.product_id),
      opts.type,
      opts.side,
      this.roundToNearest(opts.size, opts),
      opts.price,
      args
    )
    .then((result) => {
      if (result && result.message === 'Insufficient funds') {
        return cb(null, {
          status: 'rejected',
          reject_reason: 'balance'
        })
      }
      const order = {
        id: result ? result.id : null,
        status: 'open',
        price: result.average,
        size: this.roundToNearest(opts.size, opts),
        post_only: !!opts.post_only,
        created_at: new Date().getTime(),
        filled_size: '0',
        order_type: opts.type === 'limit' ? 'maker' : 'taker'
      }
      this.orders['~' + result.id] = order
      cb(null, order)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      if (
        error.name &&
        error.name.match(/InvalidOrder|InsufficientFunds|BadRequest/)
      ) {
        return cb(null, {
          status: 'rejected',
          reject_reason: error.name
        })
      }
      if (error.message.match(/-1013|MIN_NOTIONAL|-2010/)) {
        return cb(null, {
          status: 'rejected',
          reject_reason: 'balance'
        })
      }
      return this.retry('sell', func_args)
    })
}

CcxtConnector.prototype.roundToNearest = function (numToRound, opts) {
  const product = _.find(this.getProducts(), {
    asset: opts.product_id.split('-')[0],
    currency: opts.product_id.split('-')[1]
  })
  const numToRoundTo = 1 / product.min_size
  return Math.floor(numToRound * numToRoundTo) / numToRoundTo
}

CcxtConnector.prototype.getOrder = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  const order = this.orders['~' + opts.order_id]
  client.fetchOrder(opts.order_id, this.joinProduct(opts.product_id)).then(
    (body) => {
      if (order) {
        if (body.status !== 'open' && body.status !== 'canceled') {
          order.status = 'done'
          order.done_at = new Date().getTime()
          order.price = body.average
            ? parseFloat(body.average)
            : parseFloat(body.price)
          order.filled_size =
            parseFloat(body.amount) - parseFloat(body.remaining)
          return cb(null, order)
        }
        cb(null, order)
      } else {
        cb(null, body)
      }
    },
    (err) => {
      if (err.name && err.name.match(/InvalidOrder|BadRequest/)) {
        return cb(err)
      }
      return this.retry('getOrder', func_args, err)
    }
  )
}

CcxtConnector.prototype.getOrders = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  client
    .fetchOrders(this.joinProduct(opts.product_id), opts.since, opts.limit)
    .then(
      (body) => {
        cb(null, body)
      },
      (err) => {
        if (err.name && err.name.match(/InvalidOrder|BadRequest/)) {
          return cb(err)
        }
        return this.retry('getOrders', func_args, err)
      }
    )
}

CcxtConnector.prototype.getCursor = function (trade) {
  return trade.time || trade
}

CcxtConnector.prototype.updateLeverage = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  client
    .setLeverage(opts.leverage, this.joinProduct(opts.product_id))
    .then((result) => {
      cb(null, result)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      return this.retry('updateLeverage', func_args)
    })
}

CcxtConnector.prototype.updateMarginMode = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  client
    .setMarginMode(opts.marginType, this.joinProduct(opts.product_id))
    .then((result) => {
      cb(null, result)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      return this.retry('updateMarginMode', func_args)
    })
}

CcxtConnector.prototype.initFees = function () {
  const keys = this.conf.secret.keys[this.exchagneId]
  if (keys && keys.takerFee) {
    this.takerFee = keys.takerFee
  }
  if (keys && keys.makerFee) {
    this.makerFee = keys.makerFee
  }
  if (this.so.takerFee) {
    this.takerFee = this.so.takerFee
  }
  if (this.so.makerFee) {
    this.makerFee = this.so.makerFee
  }
}

CcxtConnector.prototype.updateSymbols = function (symbols) {
  const products = this.getProducts()
  return symbols
    ? symbols.filter((sy) =>
        products.find((p) => p.normalized === sy.normalized)
      )
    : []
}

module.exports = CcxtConnector
