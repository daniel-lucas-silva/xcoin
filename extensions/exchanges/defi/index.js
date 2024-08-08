const path = require('path')
const fs = require('fs')
const colors = require('colors')
const moment = require('moment')
const tb = require('timebucket')
const HttpsProxyAgent = require('https-proxy-agent')
const pancakeswap = require('./lib/pancakeswap')
const uniswap = require('./lib/uniswap')
const options = {}

function DefiConnector(conf, so, inOptions) {
  this.conf = conf
  this.so = so
  this.options = Object.assign({}, inOptions || {})
  this.exchagneId = so.exchange || 'ccxt'
  this.ccxt = {
    pancakeswap,
    uniswap
  }
  this.authed_client = null
  this.products = null
  this.orders = {}
  this.logger = conf.logger
  so.symbols = this.updateSymbols(so.symbols)
}

DefiConnector.prototype.authedClient = function () {
  if (!this.authed_client) {
    const keys = this.conf.secret.keys[this.exchagneId]
    if (!keys) {
      throw new Error(
        `please configure your ${this.exchagneId} credentials in ${path.resolve(__dirname, 'conf.js')}`
      )
    }
    this.authed_client = new this.ccxt[this.exchagneId]({
      wallet: keys.wallet,
      exchange: this.exchagneId
    })
    this.setProxy(this.authed_client)
  }
  return this.authed_client
}

DefiConnector.prototype.setProxy = function (client) {
  if (this.so.proxy) {
    client.agent = HttpsProxyAgent(this.so.proxy)
  }
}

DefiConnector.prototype.retry = function (method, args, err) {
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

DefiConnector.prototype.periodOfHour = function (period) {
  const periodToHour = {
    '1h': '1',
    '2h': '2',
    '4h': '4',
    '8h': '8',
    '12h': '12',
    '24h': '24',
    '1d': '24',
    '3d': '72',
    '1w': '168'
  }
  return periodToHour[period]
}

DefiConnector.prototype.initFees = function () {
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

DefiConnector.prototype.refreshProducts = function (cb, force = true) {
  if (!force) {
    return cb(this.getProducts())
  }
  const client = this.authedClient()
  client.fetchMarkets(this.conf.defi).then(({ newTokenList, blacklist }) => {
    const resProducts = newTokenList.map((market) => ({
      id: market.id,
      asset: market.base,
      symbol: market.symbol,
      csymbol: market.csymbol,
      currency: market.quote,
      active: market.active,
      decimals: market.decimals.toString(),
      price: market.price,
      created: market.created,
      volumeUSD: market.volumeUSD,
      txCount: market.txCount,
      label: market.name
        ? market.name.replace('unknown', market.symbol)
        : market.name,
      verified: market.verified,
      contract_name: market.contract_name,
      total_supply: market.total_supply || '',
      holders: market.holders || '',
      site: market.site || '',
      social: market.social || '',
      exchagne_id: this.exchagneId,
      product_id: `${market.symbol}-${market.csymbol}`,
      normalized: `${this.exchagneId}.${market.symbol}-${market.csymbol}`
    }))
    const exitProducts = this.getProducts()
    const newProducts = []
    resProducts.forEach((product) => {
      const find = exitProducts.find((p) => p.id === product.id)
      if (find) {
        Object.assign(find, product)
      } else {
        newProducts.push(product)
        exitProducts.push(product)
      }
    })
    const target = path.resolve(
      __dirname,
      `../../../data/exchanges/${this.exchagneId}_products.json`
    )
    fs.writeFileSync(target, JSON.stringify(exitProducts, null, 2))
    if (newProducts.length) {
      const newProductTarget = path.resolve(
        __dirname,
        `../../../data/exchanges/${this.exchagneId}_new.json`
      )
      fs.writeFileSync(newProductTarget, JSON.stringify(newProducts, null, 2))
    }
    if (blacklist.length) {
      const blacklistTarget = path.resolve(
        __dirname,
        `../../../data/exchanges/${this.exchagneId}_blacklist.json`
      )
      fs.writeFileSync(blacklistTarget, JSON.stringify(blacklist, null, 2))
    }
    cb(exitProducts, newProducts)
  })
}

DefiConnector.prototype.addProducts = function (plist, cb) {
  const client = this.authedClient()
  client.fetchProducts(plist).then(({ newTokenList }) => {
    const resProducts = newTokenList.map((market) => ({
      id: market.id,
      asset: market.base,
      symbol: market.symbol,
      csymbol: market.csymbol,
      currency: market.quote,
      active: market.active,
      decimals: market.decimals.toString(),
      price: market.price,
      created: market.created,
      volumeUSD: market.volumeUSD,
      txCount: market.txCount,
      label: market.name
        ? market.name.replace('unknown', market.symbol)
        : market.name,
      verified: market.verified,
      contract_name: market.contract_name,
      total_supply: market.total_supply || '',
      holders: market.holders || '',
      site: market.site || '',
      social: market.social || '',
      exchagne_id: this.exchagneId,
      product_id: `${market.symbol}-${market.csymbol}`,
      normalized: `${this.exchagneId}.${market.symbol}-${market.csymbol}`
    }))
    const exitProducts = this.getProducts()
    resProducts.forEach((product) => {
      const find = exitProducts.find((p) => p.id === product.id)
      if (find) {
        Object.assign(find, product)
      } else {
        exitProducts.push(product)
      }
    })
    const target = path.resolve(
      __dirname,
      `../../../data/exchanges/${this.exchagneId}_products.json`
    )
    fs.writeFileSync(target, JSON.stringify(exitProducts, null, 2))
    if (resProducts.length) {
      const newProductTarget = path.resolve(
        __dirname,
        `../../../data/exchanges/${this.exchagneId}_new.json`
      )
      fs.writeFileSync(newProductTarget, JSON.stringify(resProducts, null, 2))
    }
    cb(resProducts)
  })
}

DefiConnector.prototype.getProducts = function () {
  if (this.products) return this.products
  try {
    return require(`../../../data/exchanges/${this.exchagneId}_products.json`)
  } catch (e) {
    return []
  }
}

DefiConnector.prototype.getPoolOptions = function (opts) {
  let product
  if (opts.product_id) {
    product = this.products.find((p) => p.product_id === opts.product_id)
  } else if (opts.asset) {
    product = this.products.find((p) => p.asset === opts.asset)
  }
  if (product) {
    opts.id = product.id
    opts.decimals = product.decimals
    opts.asset = product.asset
    opts.currency = product.currency
    opts.symbol = product.symbol
    opts.csymbol = product.csymbol
  }
  return opts
}

DefiConnector.prototype.getTrades = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const authlient = this.authedClient()
  if (!opts.from) opts.from = 0
  this.getPoolOptions(opts)
  authlient
    .fetchTrades(opts)
    .then((result) => {
      const trades = result.map((trade) => ({
        trade_id: trade.id,
        time: trade.timestamp,
        size: parseFloat(trade.amount),
        price: trade.price,
        side: trade.side
      }))
      cb(null, trades)
    })
    .catch((error) => {
      this.logger.error('getTrades An error occurred:' + error.toString())
      return this.retry('getTrades', func_args)
    })
}

DefiConnector.prototype.getKLines = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const authlient = this.authedClient()
  if (!opts.from) opts.from = 0

  if (opts.period === '1d') {
    opts.from = tb().resize(opts.period).subtract(opts.limit).toMilliseconds()
    this.getPoolOptions(opts)
    authlient
      .fetchOHLCV2(opts)
      .then((result) => {
        const klines = []
        result.forEach((kline) => {
          const d = tb(kline[0]).resize(opts.period)
          const de = tb(kline[0]).resize(opts.period).add(1)
          const find = klines.find((kl) => kl.period_id === d.toString())
          if (!find) {
            klines.push({
              period_id: d.toString(),
              time: d.toMilliseconds(),
              size: opts.period,
              close_time: de.toMilliseconds() - 1,
              closeStr: moment(de.toMilliseconds() - 1).format('YYYYMMDDHHMM'),
              open: kline[1],
              high: kline[2],
              low: kline[3],
              close: kline[4],
              volume: kline[5]
            })
          } else {
            Object.assign(find, {
              high: Math.max(find.high, kline[2]),
              low: Math.min(find.low, kline[3]),
              close: kline[4],
              volume: find.volume + kline[5]
            })
          }
        })
        cb(null, klines)
      })
      .catch((error) => {
        this.logger.error('getKLines An error occurred:' + error.toString())
        if (
          error.name &&
          error.name.match(
            /BadSymbol|InvalidOrder|InsufficientFunds|BadRequest/
          )
        ) {
          return cb(error.name, {
            status: 'rejected',
            reject_reason: error.name
          })
        }
        return this.retry('getKLines', func_args)
      })
  } else {
    const comineNumb = this.periodOfHour(opts.period)
    opts.limit = comineNumb * opts.limit
    opts.from = tb().resize('1h').subtract(opts.limit).toMilliseconds()
    this.getPoolOptions(opts)
    authlient
      .fetchOHLCV(opts)
      .then((result) => {
        const klines = []
        result.forEach((kline) => {
          const d = tb(kline[0]).resize(opts.period)
          const de = tb(kline[0]).resize(opts.period).add(1)
          const find = klines.find((kl) => kl.period_id === d.toString())
          if (!find) {
            klines.push({
              period_id: d.toString(),
              time: d.toMilliseconds(),
              size: opts.period,
              close_time: de.toMilliseconds() - 1,
              closeStr: moment(de.toMilliseconds() - 1).format('YYYYMMDDHHMM'),
              open: kline[1],
              high: kline[2],
              low: kline[3],
              close: kline[4],
              volume: kline[5]
            })
          } else {
            Object.assign(find, {
              high: Math.max(find.high, kline[2]),
              low: Math.min(find.low, kline[3]),
              close: kline[4],
              volume: find.volume + kline[5]
            })
          }
        })
        cb(null, klines)
      })
      .catch((error) => {
        this.logger.error('getKLines An error occurred:' + error.toString())
        if (
          error.name &&
          error.name.match(
            /BadSymbol|InvalidOrder|InsufficientFunds|BadRequest/
          )
        ) {
          return cb(error.name, {
            status: 'rejected',
            reject_reason: error.name
          })
        }
        return this.retry('getKLines', func_args)
      })
  }
}

DefiConnector.prototype.cancelOrder = function (opts, cb) {
  return cb(null) // Decentralized platforms cannot cancel transactions
}

DefiConnector.prototype.buy = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  if (typeof opts.post_only === 'undefined') opts.post_only = true
  opts.type = 'limit'
  const args = {}
  if (opts.order_type === 'taker') {
    delete opts.post_only
    opts.type = 'market'
  }
  if (!client.has.createMarketOrder) opts.type = 'limit'
  opts.side = 'buy'
  delete opts.order_type
  this.getPoolOptions(opts)
  opts.extractIn = opts.price ? opts.price * opts.size : opts.size
  opts.slippage = this.conf.max_slippage_pct
  client
    .createOrder(
      opts,
      opts.type,
      opts.side,
      opts.extractIn,
      opts.price,
      opts.slippage,
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
        price: result.price || opts.price,
        size: opts.size,
        post_only: !!opts.post_only,
        created_at: new Date().getTime(),
        filled_size: '0',
        ordertype: opts.order_type
      }
      this.orders['~' + result.id] = order
      cb(null, order)
    })
    .catch((error) => {
      this.logger.error('buy An error occurred:' + error.toString())
      if (
        error.toString().match(/GetBuyTradeError|INSUFFICIENT_FUNDS|BadRequest/)
      ) {
        return cb(null, {
          status: 'rejected',
          reject_reason: error.name
        })
      }
      return this.retry('buy', func_args)
    })
}

DefiConnector.prototype.sell = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  if (typeof opts.post_only === 'undefined') opts.post_only = true
  opts.type = 'limit'
  const args = {}
  if (opts.order_type === 'taker') {
    delete opts.post_only
    opts.type = 'market'
  }
  if (!client.has.createMarketOrder) opts.type = 'limit'
  opts.side = 'sell'
  delete opts.order_type
  this.getPoolOptions(opts)
  opts.extractIn = opts.price ? opts.price * opts.size : opts.size
  opts.slippage = this.conf.max_slippage_pct
  client
    .createOrder(
      opts,
      opts.type,
      opts.side,
      opts.size,
      opts.price,
      opts.slippage,
      args
    )
    .then((result) => {
      if (result && result.message === 'Insufficient funds') {
        return cb(null, {
          status: 'rejected',
          reject_reason: 'balance'
        })
      } else if (!result.id) {
        return cb(null, {
          status: 'rejected',
          reject_reason: 'create order error'
        })
      }
      const order = {
        id: result ? result.id : null,
        status: 'open',
        price: result.price || opts.price,
        size: opts.size,
        post_only: !!opts.post_only,
        created_at: new Date().getTime(),
        filled_size: '0',
        ordertype: opts.order_type
      }
      this.orders['~' + result.id] = order
      cb(null, order)
    })
    .catch((error) => {
      this.logger.error('sell An error occurred:' + error.toString())
      if (
        error.toString().match(/GetBuyTradeError|INSUFFICIENT_FUNDS|BadRequest/)
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

DefiConnector.prototype.getBalance = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  this.getPoolOptions(opts)
  let tokens = [opts.asset]
  if (opts.symbols) {
    tokens = opts.symbols.map((s) => s.asset)
  }
  client
    .fetchBalance(tokens)
    .then((result) => {
      const balance = { asset: 0, currency: 0 }
      Object.keys(result).forEach((key) => {
        if (key.toLowerCase() === opts.currency.toLowerCase()) {
          balance.currency = result[key].free + result[key].used
          balance.currency_hold = result[key].used
        } else {
          const num = result[key].free + result[key].used
          if (!balance.assets) balance.assets = {}
          balance.assets[key] = {
            asset: num,
            asset_hold: result[key].used
          }
        }
        if (key.toLowerCase() === opts.asset.toLowerCase()) {
          balance.asset = result[key].free + result[key].used
          balance.asset_hold = result[key].used
        }
      })
      cb(null, balance)
    })
    .catch((error) => {
      this.logger.error('getBalance An error occurred:' + error.toString())
      return this.retry('getBalance', func_args)
    })
}

DefiConnector.prototype.getOrder = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  const order = this.orders['~' + opts.order_id] || {}
  client
    .fetchOrder(opts.order_id)
    .then((body) => {
      if (body.status === 'rejected') {
        order.status = 'rejected'
        order.reject_reason = 'balance'
        order.done_at = new Date().getTime()
        order.filled_size = 0
        return cb(null, order)
      } else if (body.status !== 'open' && body.status !== 'canceled') {
        order.status = 'done'
        order.done_at = new Date().getTime()
        order.defi_fee = body.defi_fee
        order.filled_size = 0
        return cb(null, order)
      }
      cb(null, order)
    })
    .catch((err) => {
      if (err.name && err.name.match(/InvalidOrder|BadRequest/)) {
        return cb(err)
      }
      return this.retry('getOrder', func_args, err)
    })
}

DefiConnector.prototype.getQuote = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  this.getPoolOptions(opts)
  client
    .fetchTicker(opts)
    .then((result) => {
      cb(null, {
        bid: result.bid,
        ask: result.ask,
        dayVolume: result.dayVolume
      })
    })
    .catch((error) => {
      this.logger.error('getQuote An error occurred:' + error.toString())
      return this.retry('getQuote', func_args)
    })
}

DefiConnector.prototype.getTickers = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  opts.symbols.forEach((f) => {
    this.getPoolOptions(f)
  })
  client
    .fetchTickers(opts.symbols)
    .then((result) => {
      Object.keys(result).forEach((r) => {
        result[r].normalized =
          `${options.defaultType === 'future' ? this.exchagneId + 'future.' : this.exchagneId + '.'}${r.replace('/', '-')}`
      })
      cb(null, result)
    })
    .catch((error) => {
      this.logger.error('getTickers An error occurred:' + error.toString())
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

DefiConnector.prototype.getPool = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  this.getPoolOptions(opts)
  client
    .fetchPool(opts)
    .then((result) => {
      cb(null, result)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      return this.retry('getPair', func_args)
    })
}

DefiConnector.prototype.getToken = function (opts, cb) {
  const func_args = [].slice.call(arguments)
  const client = this.authedClient()
  client
    .fetchToken(opts)
    .then((result) => {
      cb(null, result)
    })
    .catch((error) => {
      console.error('An error occurred', error)
      return this.retry('getToken', func_args)
    })
}

DefiConnector.prototype.getCursor = function (trade) {
  return trade.time || trade
}

DefiConnector.prototype.updateSymbols = function (symbols) {
  this.products = this.getProducts()
  let filterProducts = this.products.filter(
    (p) => p.holders < this.so.defi.maxHolders
  )
  filterProducts = filterProducts.filter(
    (p) => p.volumeUSD && p.volumeUSD < this.so.defi.maxVolumeUSD
  )

  const target = path.resolve(
    __dirname,
    `../../../data/exchanges/${this.exchagneId}_products.json`
  )
  fs.writeFileSync(target, JSON.stringify(filterProducts, null, 2))

  if (symbols) {
    return symbols
      .filter((sy) => {
        return filterProducts.find((p) => p.normalized === sy.normalized)
      })
      .map((sy) => {
        const product = filterProducts.find(
          (p) => p.normalized === sy.normalized
        )
        return {
          asset: product.asset,
          currency: product.currency,
          symbol: product.symbol,
          csymbol: product.csymbol,
          id: product.id,
          decimals: product.decimals,
          exchange_id: product.exchagne_id,
          product_id: product.product_id,
          normalized: product.normalized
        }
      })
  } else {
    return []
  }
}

module.exports = DefiConnector
