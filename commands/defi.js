const minimist = require('minimist')
const n = require('numbro')
const path = require('path')
const _ = require('lodash')
const debug = require('../lib/debug')
const helpers = require('../lib/helpers')
const tb = require('timebucket')
const colors = require('colors')
const fs = require('fs')

module.exports = function (program, conf) {
  program
    .command('defi [exchange]')
    .allowUnknownOption()
    .description('test defi function')
    .option('--debug', 'output with debug info')
    .option(
      '--watch_symbols <watch_symbols>',
      'watch_symbols',
      String,
      conf.watch_symbols
    )
    .option('--secret <path>', 'custom exchange api secret', String, '')
    .option('--proxy <proxy>', 'use proxy', String, conf.proxy)
    .option('--pool', 'get pool info')
    .option('--token', 'get token info')
    .action(function (exchangename, cmd) {
      let so = {}
      conf.proxy = cmd.proxy
      conf.watch_symbols = cmd.watch_symbols
      conf.buy_pct = cmd.buy
      conf.sell_pct = cmd.sell
      conf.position_side = (cmd.balance || 'long').toUpperCase()
      conf.exchange = exchangename
      Object.keys(conf).forEach(function (k) {
        if (
          k !== 'eventBus' &&
          k !== 'logger' &&
          k !== 'secret' &&
          k !== 'db'
        ) {
          so[k] = conf[k]
        }
      })
      delete so._
      let symbolsIds = so.watch_symbols.split(',')
      so.symbols = symbolsIds.map((symbol) => {
        return helpers.objectifySelector(symbol)
      })
      //  console.log("so", so);
      var exchange
      try {
        exchange = require(
          path.resolve(
            __dirname,
            `../extensions/exchanges/${exchangename}/exchange`
          )
        )(conf, so)
      } catch (e) {
        if (so.defi) {
          exchange = require(
            path.resolve(__dirname, '../extensions/exchanges/defi/exchange')
          )(conf, so)
        } else {
          exchange = require(
            path.resolve(__dirname, '../extensions/exchanges/ccxt/exchange')
          )(conf, so)
        }
      }
      console.log('so.symbols', so.symbols)
      //implement pool
      if (so.pool) {
        //get pool
        let opts = {
          product_id: so.symbols[0].product_id
        }
        exchange.getPool(opts, function (err, pool) {
          if (err) console.log('error', err)
          // console.log("getPool ok", pool);
          process.exit
        })
        return
      }

      //implement token
      if (so.token) {
        //get token
        let opts = {
          token: so.symbols[0].asset
        }
        exchange.getToken(opts, function (err, token) {
          if (err) console.log('error', err)
          console.log('getToken.', token)
          process.exit(0)
        })
        return
      }
      process.exit(0)
    })
}
