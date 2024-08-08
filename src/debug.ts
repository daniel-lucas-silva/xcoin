// import moment from 'moment'

class Debug {
  on() {
    throw new Error('Unimplemented error')
  }
  flip() {
    throw new Error('Unimplemented error')
  }
  msg(text: string) {
    throw new Error('Unimplemented error')
  }
}

export default new Debug()
