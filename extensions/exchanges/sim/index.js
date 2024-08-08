const path = require('path')
const n = require('numbro')
const _ = require('lodash')

function SimConnector(conf, so, s) {
  this.conf = conf
  this.so = so
  this.s = s
  this.latency = 100 // Em milissegundos, o suficiente para ser realista sem ser disruptivo
  this.real_exchange = this.initializeExchange()
  this.now = null
  this.last_order_id = 1001
  this.orders = {}
  this.openOrders = {}
  this.logger = conf.logger

  this.real_exchange.updateSymbols(so.symbols)
}

SimConnector.prototype.initializeExchange = function () {
  try {
    return require(path.resolve(__dirname, `../${this.so.exchange}/exchange`))(
      this.conf,
      this.so
    )
  } catch (e) {
    return require(path.resolve(__dirname, '../ccxt/exchange'))(
      this.conf,
      this.so
    )
  }
}

SimConnector.prototype.recalcHold = function (product_id) {
  let balance = this.s.balance
  balance.currency_hold = 0
  this.s.symbols[product_id].asset_hold = 0
  _.each(this.openOrders, (order) => {
    if (order.tradetype === 'buy') {
      balance.currency_hold += n(order.remaining_size)
        .multiply(n(order.price).valueOf())
        .value()
    } else {
      this.s.symbols[product_id].asset_hold += n(order.remaining_size).value()
    }
  })
}

SimConnector.prototype.initFees = function () {
  this.real_exchange.initFees()
  if (this.so.future) {
    this.makerFee = this.real_exchange.makerFee * (this.so.leverage || 20)
    this.takerFee = this.real_exchange.takerFee * (this.so.leverage || 20)
  } else {
    this.makerFee = this.real_exchange.makerFee
    this.takerFee = this.real_exchange.takerFee
  }
}

SimConnector.prototype.refreshProducts = function (cb, force = false) {
  return this.real_exchange.refreshProducts(cb, force)
}

SimConnector.prototype.getTrades = function (opts, cb) {
  return this.real_exchange.getTrades(opts, cb)
}

SimConnector.prototype.getKLines = function (opts, cb) {
  return this.real_exchange.getKLines(opts, cb)
}

SimConnector.prototype.getBalance = function (opts, cb) {
  setTimeout(() => {
    let symbol = this.so.symbols.find(
      (s) => s.currency === opts.currency && s.asset === opts.asset
    )
    if (!symbol) symbol = { product_id: opts.asset + '-' + opts.currency }
    let balance = {
      currency: this.s.balance.currency,
      currency_hold: this.s.balance.currency_hold,
      asset: this.s.symbols[symbol.product_id].asset_amount,
      asset_hold: this.s.symbols[symbol.product_id].asset_hold,
      unrealizedProfit: this.s.symbols[symbol.product_id].unrealizedProfit,
      leverage: this.s.symbols[symbol.product_id].leverage,
      isolated: this.s.symbols[symbol.product_id].isolated,
      positionSide: 'LONG'
    }
    return cb(null, balance)
  }, this.latency)
}

SimConnector.prototype.getQuote = function (opts, cb) {
  if (this.so.mode === 'paper' && !this.so.sim_price) {
    return this.real_exchange.getQuote(opts, cb)
  } else {
    setTimeout(() => {
      return cb(null, {
        bid: this.s.symbols[opts.product_id].period.close,
        ask: this.s.symbols[opts.product_id].period.close
      })
    }, this.latency)
  }
}

SimConnector.prototype.getTickers = function (opts, cb) {
  if (this.so.mode === 'paper') {
    return this.real_exchange.getTickers(opts, cb)
  } else {
    setTimeout(() => {
      let priceArr = Object.keys(opts).map((key) => {
        return opts[key].period.close
      })
      return cb(null, priceArr)
    }, this.latency)
  }
}

SimConnector.prototype.cancelOrder = function (opts, cb) {
  setTimeout(() => {
    var order_id = '~' + opts.order_id
    var order = this.orders[order_id]

    if (order.status === 'open') {
      order.status = 'cancelled'
      delete this.openOrders[order_id]
      this.recalcHold(opts.product_id)
    }

    cb(null)
  }, this.latency)
}

SimConnector.prototype.buy = function (opts, cb) {
  setTimeout(() => {
    this.logger.debug(
      `buying ${opts.size * opts.price} vs on hold: ${
        this.s.balance.currency
      } - ${this.s.balance.currency_hold} = ${
        this.s.balance.currency - this.s.balance.currency_hold
      }`
    )
    if (
      opts.size * opts.price >
      this.s.balance.currency - this.s.balance.currency_hold
    ) {
      this.logger.debug('nope')
      return cb(null, { status: 'rejected', reject_reason: 'balance' })
    }

    var result = {
      id: this.last_order_id++
    }
    if (this.so.mode !== 'live') {
      this.now = new Date().getTime()
    }
    var order = {
      id: result.id,
      status: 'open',
      price: opts.price,
      size: opts.size,
      orig_size: opts.size,
      remaining_size: opts.size,
      post_only: !!opts.post_only,
      filled_size: 0,
      ordertype: opts.order_type,
      tradetype: 'buy',
      orig_time: this.now,
      time: this.now,
      created_at: this.now,
      position_side: opts.position_side,
      product_id: opts.product_id
    }
    this.orders['~' + result.id] = order
    this.openOrders['~' + result.id] = order
    this.recalcHold(order.product_id)
    cb(null, order)
    setTimeout(() => {
      if (this.so.mode !== 'live') {
        this.processTrade({
          price: order.price,
          size: order.size,
          time: order.time + this.so.order_adjust_time + 1,
          product_id: order.product_id
        })
      }
    }, this.latency)
  }, this.latency)
}

SimConnector.prototype.sell = function (opts, cb) {
  setTimeout(() => {
    this.logger.debug(
      `selling ${opts.size} vs on hold: ${
        this.s.symbols[opts.product_id].asset_amount
      } - ${this.s.symbols[opts.product_id].asset_hold} = ${
        this.s.symbols[opts.product_id].asset_amount -
        this.s.symbols[opts.product_id].asset_hold
      }`
    )
    if (
      opts.size >
      this.s.balance.asset - this.s.symbols[opts.product_id].asset_hold
    ) {
      this.logger.debug('nope')
      return cb(null, { status: 'rejected', reject_reason: 'balance' })
    }

    var result = {
      id: this.last_order_id++
    }
    if (this.so.mode !== 'live') {
      this.now = new Date().getTime()
    }
    var order = {
      id: result.id,
      status: 'open',
      price: opts.price,
      size: opts.size,
      orig_size: opts.size,
      remaining_size: opts.size,
      post_only: !!opts.post_only,
      filled_size: 0,
      ordertype: opts.order_type,
      tradetype: 'sell',
      orig_time: this.now,
      time: this.now,
      created_at: this.now,
      position_side: opts.position_side,
      product_id: opts.product_id
    }
    this.orders['~' + result.id] = order
    this.openOrders['~' + result.id] = order
    this.recalcHold(opts.product_id)
    cb(null, order)
    setTimeout(() => {
      if (this.so.mode !== 'live') {
        this.processTrade({
          price: order.price,
          size: order.size,
          time: order.time + this.so.order_adjust_time + 1,
          product_id: order.product_id
        })
      }
    }, this.latency)
  }, this.latency)
}

SimConnector.prototype.getOrder = function (opts, cb) {
  setTimeout(() => {
    var order = this.orders['~' + opts.order_id]
    cb(null, order)
  }, this.latency)
}

SimConnector.prototype.getCursor = function () {
  return this.real_exchange.getCursor()
}

SimConnector.prototype.getTime = function () {
  return this.now
}

SimConnector.prototype.processTrade = function (trade) {
  this.now = trade.time
  _.each(this.openOrders, (order) => {
    if (trade.time - order.time < this.so.order_adjust_time) {
      return // Not time yet
    }
    if (
      order.tradetype === 'buy' &&
      (this.so.mode === 'sim' || trade.price <= order.price)
    ) {
      this.processBuy(order, trade)
      this.recalcHold(order.product_id)
    } else if (
      order.tradetype === 'sell' &&
      (this.so.mode === 'sim' || trade.price >= order.price)
    ) {
      this.processSell(order, trade)
      this.recalcHold(order.product_id)
    }
  })
}

SimConnector.prototype.processBuy = function (buy_order, trade) {
  let fee = 0
  let size = Math.min(buy_order.remaining_size, trade.size)
  if (this.so.mode === 'sim') {
    size = buy_order.remaining_size
  }
  let price = buy_order.price

  // Adiciona deslizamento estimado ao preço
  if (this.so.order_type === 'maker') {
    price = n(price)
      .add(
        n(price)
          .multiply(this.so.avg_slippage_pct / 100)
          .valueOf()
      )
      .format('0.00000000')
  }

  let total = n(price).multiply(size)

  // Calcula as taxas
  if (this.so.order_type === 'maker' && this.makerFee) {
    fee = n(size)
      .multiply(this.makerFee / 100)
      .value()
  } else if (this.so.order_type === 'taker' && this.takerFee) {
    fee = n(size)
      .multiply(this.takerFee / 100)
      .value()
  }

  this.s.symbols[buy_order.product_id].asset_amount = Number(
    n(this.s.symbols[buy_order.product_id].asset_amount)
      .add(size)
      .subtract(fee)
      .format(
        this.s.symbols[buy_order.product_id].asset_increment
          ? this.s.symbols[buy_order.product_id].asset_increment
          : this.so.price_format
      )
  )
  this.s.balance.currency = Number(
    n(this.s.balance.currency)
      .subtract(total.valueOf())
      .format(this.so.price_format)
  )

  // Processa alterações de tamanho do pedido existente
  buy_order.filled_size += size
  buy_order.remaining_size = buy_order.size - buy_order.filled_size

  if (buy_order.remaining_size <= 0) {
    this.logger.debug(buy_order.product_id.green, 'full fill bought'.cyan)
    buy_order.status = 'done'
    buy_order.done_at = trade.time
    delete this.openOrders['~' + buy_order.id]
  } else {
    this.logger.debug(buy_order.product_id.green, 'partial fill buy'.cyan)
  }
}

SimConnector.prototype.processSell = function (sell_order, trade) {
  let fee = 0
  let size = Math.min(sell_order.remaining_size, trade.size)
  if (this.so.mode === 'sim') {
    size = sell_order.remaining_size
  }
  let price = sell_order.price

  // Adiciona deslizamento estimado ao preço
  if (this.so.order_type === 'maker') {
    price = n(price)
      .subtract(
        n(price)
          .multiply(this.so.avg_slippage_pct / 100)
          .valueOf()
      )
      .format('0.00000000')
  }

  let total = n(price).multiply(size)
  if (sell_order.position_side === 'SHORT') {
    let initTotal = n(this.s.symbols[trade.product_id].last_buy_price).multiply(
      size
    )
    total = initTotal + (initTotal - total)
  }

  // Calcula as taxas
  if (this.so.order_type === 'maker' && this.makerFee) {
    fee = n(total)
      .multiply(this.makerFee / 100)
      .value()
  } else if (this.so.order_type === 'taker' && this.takerFee) {
    fee = n(total)
      .multiply(this.takerFee / 100)
      .value()
  }

  this.s.symbols[sell_order.product_id].asset_amount = Number(
    n(this.s.symbols[sell_order.product_id].asset_amount)
      .subtract(size)
      .format(
        this.s.symbols[sell_order.product_id].asset_increment
          ? this.s.symbols[sell_order.product_id].asset_increment
          : this.so.price_format
      )
  )
  if (this.s.symbols[sell_order.product_id].asset_amount < 0) {
    this.s.symbols[sell_order.product_id].asset_amount = 0
  }
  this.s.balance.currency = Number(
    n(this.s.balance.currency)
      .add(total.valueOf())
      .subtract(fee)
      .format(this.so.price_format)
  )

  // Processa alterações de tamanho do pedido existente
  sell_order.filled_size += size
  sell_order.remaining_size = sell_order.size - sell_order.filled_size

  if (sell_order.remaining_size <= 0) {
    this.logger.debug(sell_order.product_id.green, 'full fill sold'.cyan)
    sell_order.status = 'done'
    sell_order.done_at = trade.time
    delete this.openOrders['~' + sell_order.id]
  } else {
    this.logger.debug(sell_order.product_id.green, 'partial fill sell'.cyan)
  }
}

module.exports = SimConnector
