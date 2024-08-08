const fs = require('fs')
const path = require('path')

let i = 0
let test = {
  async sleep(time) {
    return new Promise((resolve) => {
      setTimeout(resolve, time)
    })
  },
  async run() {
    while (true) {
      console.log('run..' + i)
      await this.sleep(3000)
      i++
      if (i % 5 === 0) {
        var target = path.resolve(__dirname, `./restart.json`)
        console.log('save to..', i, target)
        fs.writeFileSync(target, JSON.stringify({ count: i }, null, 2))
      }
    }
  }
}
test.run()
