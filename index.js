const createSwarm = require('killa-beez')
const funky = require('funky')
const getUserMedia = require('getusermedia')
const qs = require('querystring')
const dragDrop = require('drag-drop')
const streamToBlobURL = require('stream-to-blob-url')
const WebTorrent = require('webtorrent')
const bel = require('bel')
const bl = require('bl')
const blobToBuffer = require('blob-to-buffer')
const once = require('once')
const values = obj => Object.keys(obj).map(k => obj[k])
const torrentClient = new WebTorrent()

let signalHost = 'https://signalexchange.now.sh'
let roomHost = 'https://roomexchange.now.sh'

const mimemap = {'mp3': 'audio/mp3'}

function getBlobURL (file, cb) {
  if (file.createReadStream) {
    streamToBlobURL(file.createReadStream(), mimemap.mp3, cb)
  } else {
    cb(null, URL.createObjectURL(file))
  }
}

const beatTrackView = funky`
<div class="ui segment">
  <a class="ui ribbon label">${o => o.name}</a>
  ${o => o.audio}
  <input disabled
         min="0"
         step="1"
         value="0"
         class="progress-slider"
         type="range"/>
</div>
`

let myMicrophone
let myPublicKey

function addBeatTrack (file) {
  getBlobURL(file, (err, url) => {
    if (err) console.error(err)
    var elem = new Audio()
    let track
    let progress
    elem.addEventListener('error', (err) => console.error)
    elem.addEventListener('canplay', () => {
      console.log('audio is ready')
      let duration = Math.floor(elem.duration) - 1
      progress = track.querySelector('input.progress-slider')
      progress.setAttribute('max', duration)
      // Add record button
      $(document.body).prepend(recordButton)
      recordButton.onclick = () => {
        startRecording()
        values(mySwarm.remotes).forEach(remote => {
          remote.startRecording()
        })
      }
      // TODO: ready RPC call
    })
    elem.src = url
    elem.ontimeupdate = () => {
      progress.value = elem.currentTime
    }
    let o = {audio: elem, name: file.name}
    track = beatTrackView(o)
    track.querySelector('audio').id = 'beats-audio'
    document.getElementById('beats-container').appendChild(track)
  })
}

const recordButton = bel`
<button id="record" class="ui compact labeled icon button">
  <i class="unmute icon"></i>
    Record
</button>
`

const trackPlayerView = funky`
<div class="track-player">
  <div class="ui large buttons">
  <button class="ui button">
    <i class="play icon"></i>
  </button>
  <div class="or"></div>
  <a download="track.opus" class="ui button">
    <i class="save icon"></i>
  </a>
</div>
`

function addTrackPlayer (publicKey, blobURL) {
  let audio = document.createElement('audio')
  audio.src = blobURL
  audio.autoplay = false
  audio.controls = false

  let trackPlayer = trackPlayerView()
  trackPlayer.appendChild(audio)
  trackPlayer.querySelector('a').href = blobURL

  let playIcon = trackPlayer.querySelector('i')

  let _play = () => {
    audio.play()
    $(playIcon).removeClass('play').addClass('pause')
    playIcon.onclick = _pause
  }
  let _pause = () => {
    audio.pause()
    $(playIcon).removeClass('pause').addClass('play')
    playIcon.onclick = _play
  }
  playIcon.onclick = _play

  document
  .getElementById(`a${publicKey}`)
  .querySelector('div.track')
  .appendChild(trackPlayer)
}

function startRecording () {
  let constraints = { audio: true, video: false}
  let chunks = []

  let mediaRecorder = new MediaRecorder(myMicrophone)
  let audioElement = document.getElementById('beats-audio')
  audioElement.onended = () => {
    mediaRecorder.stop()
  }
  recordButton.setAttribute('disabled', true)
  recordButton.onclick = null
  audioElement.play()
  mediaRecorder.start()

  mediaRecorder.onstop = function(e) {
    console.log('onstop')
    let fullblob = new Blob(chunks, { 'type' : 'audio/ogg; codecs=opus' })
    var audioURL = window.URL.createObjectURL(fullblob)
    addTrackPlayer('undefined', audioURL)

    blobToBuffer(fullblob, (err, buffer) => {
      if (err) return console.error(err)
      torrentClient.seed(buffer, {name: `${myPublicKey}.ogg`}, torrent => {
        // TODO: push seed message.
        console.log('recorded', torrent)
        values(mySwarm.remotes).forEach(remote => {
          console.log('calling remote')
          remote.getTrack(torrent.magnetURI)
        })
      })
    })
  }

  mediaRecorder.ondataavailable = function(e) {
    chunks.push(e.data)
  }
}

function setupSwarm (swarm) {
  swarm.rpc.getTrack = torrent => {
    console.log('getTrack', torrent)
    torrentClient.add(torrent, _torrent => {
      let id = _torrent.name.slice(0, _torrent.name.lastIndexOf('.'))
      console.log(_torrent.files[0])
      getBlobURL(_torrent.files[0], (err, url) => {
        if (err) return console.error(err)
        addTrackPlayer(id, url)
      })
    })
  }
  swarm.rpc.startRecording = () => {
    startRecording()
  }
}

function joinRoom (infoHash, room) {
  if (!room) {
    room = infoHash
    infoHash = null
  }

  room = `ruckas:${room}`
  let mediaopts = { audio: true, video: false }
  getUserMedia(mediaopts, (err, audioStream) => {
    if (err) return console.error(err)
    if (!audioStream) return console.error("no audio")
    window.audioStream = audioStream
    myMicrophone = audioStream
    let p = addPerson(audioStream)
    let swarm = createSwarm(signalHost, {stream: audioStream})
    setupSwarm(swarm)
    mySwarm = swarm
    myPublicKey = swarm.publicKey
    swarm.joinRoom(roomHost, room)
    swarm.on('stream', stream => {
      // Hack.
      let audio = new Audio()
      audio.src = URL.createObjectURL(stream)
      stream.publicKey = stream.peer.publicKey
      let elem = addPerson(stream, true)
      document.getElementById('audio-container').appendChild(elem)
    })
    swarm.on('disconnect', pubKey => {
      let elem = document.getElementById(`a${pubKey}`)
      if (recordButton.getAttribute('disabled')) {
        $(elem.querySelector('canvas')).remove()
        $(elem.querySelector('div.volume')).remove()
      } else {
        $(elem).remove()
      }

    })
    document.getElementById('audio-container').appendChild(p)

    if (infoHash) {
      console.log('Adding infoHash.')
      torrentClient.add(infoHash, function (torrent) {
        console.log('Client is downloading:', torrent.infoHash)
        if (torrent.files.length > 1) {
          throw new Error('Too many files in this torrent.')
        }
        addBeatTrack(torrent.files[0])
      })
    }
  })
}
const mainButtons = funky`
<div class="join-container">
  <div>Drag and Drop some Beats into the window.</div>
</div>`

const remoteAudio = funky`
  <div class="card" id="a${id => id}">
    <div style="height:49px;width:290">
      <canvas id="canvas"
        width="290"
        height="49"
        class="person music"
        >
      </canvas>
    </div>
    <div class="track"></div>
    <div class="extra content">
      <div class="volume">
        <div class="ui toggle checkbox">
          <input type="checkbox" name="mute">
          <label>Mute</label>
        </div>
        <input type="range" min="0" max="2" step=".05" />
      </div>
    </div>
  </div>
`
let looping

function startLoop () {
  if (looping) return

  let lastTime = Date.now()

  function draw () {
    requestAnimationFrame(draw)
    var now = Date.now()
    if (now - lastTime < 50) return

    var elements = [...document.querySelectorAll('canvas.music')]
    elements.forEach(drawPerson)

    function drawPerson (canvas) {
      let canvasCtx = canvas.canvasCtx
      let analyser = canvas.analyser
      let bufferLength = analyser._bufferLength
      let HEIGHT = analyser.HEIGHT
      let WIDTH = analyser.WIDTH

      let dataArray = new Uint8Array(bufferLength)

      analyser.getByteFrequencyData(dataArray)

      canvasCtx.clearRect(0, 0, WIDTH, HEIGHT)
      let barWidth = (WIDTH / bufferLength) * 5
      let barHeight
      var x = 0
      for (var i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 3
        if (barHeight > 10) {
          canvasCtx.fillStyle = 'rgb(66,133,244)'
          canvasCtx.fillRect(x, HEIGHT - barHeight / 2, barWidth, barHeight)
        }
        x += barWidth + 1
      }
      lastTime = now
    }
  }
  draw()
  looping = true
}

let context = new AudioContext()

function addPerson (stream, play) {
  let element = remoteAudio(stream.publicKey)
  let volume = context.createGain()
  let analyser = context.createAnalyser()
  let source = context.createMediaStreamSource(stream)
  let volumeSelector = 'input[type=range]'
  let muteSelector = 'input[type=checkbox]'
  let muteElement = element.querySelector(muteSelector)

  $(muteElement).checkbox('toggle').click((c) => {
    let label = c.target.parentNode.querySelector('label')
    let state = label.textContent
    if (state === 'Mute') {
      c.target.parentNode.querySelector('label').textContent = 'Muted'
      element.querySelector(volumeSelector).disabled = true
      stream.getAudioTracks().forEach(t => t.enabled = false)
    } else {
      c.target.parentNode.querySelector('label').textContent = 'Mute'
      element.querySelector(volumeSelector).disabled = false
      stream.getAudioTracks().forEach(t => t.enabled = true)
    }
  })

  $(element.querySelector(volumeSelector)).change(function () {
    volume.gain.value = this.value
  })
  source.connect(volume)
  volume.connect(analyser)

  var canvas = element.querySelector('canvas.person')
  canvas.canvasCtx = canvas.getContext("2d")
  analyser.fftSize = 256
  analyser._bufferLength = analyser.frequencyBinCount
  canvas.analyser = analyser
  let WIDTH = canvas.getAttribute('width')
  let HEIGHT = canvas.getAttribute('height')
  canvas.analyser.WIDTH = WIDTH
  canvas.analyser.HEIGHT = HEIGHT
  canvas.canvasCtx.clearRect(0, 0, WIDTH, HEIGHT)
  console.log(canvas.analyser.WIDTH, canvas.analyser.HEIGHT)
  startLoop()

  if (play) {
    volume.connect(context.destination)
  }

  element.stream = stream
  element.volume = volume

  return element
}

function ask () {
  let buttons = mainButtons()
  document.getElementById('main-container').appendChild(buttons)
  function onDrop (files) {
    if (files.length > 1) {
      alert('Cannot handle more than one file.')
    }
    // TODO: error on unsupported media types.
    $('#upload-modal').modal('show')
    torrentClient.seed(files, function (torrent) {
      console.log(torrent)
      window.torrent = torrent
      console.log('Client is seeding:', torrent.infoHash)
      $('div#encrypt-modal').modal('show')
      setTimeout(() => {
        $('div#encrypt-modal').modal('hide')
        $('#upload-modal').modal('hide')
        let state = { infoHash: torrent.magnetURI, rand: getRandom() }
        let query = { room:`${state.infoHash}/${state.rand}` }
        history.pushState(state, "Bring tha Ruckus", '?' + qs.stringify(query))
        $(buttons).remove()
        joinRoom(query.room)
        addBeatTrack(files[0])
      }, 1)
    })
  }
  dragDrop('body', {
    onDrop: onDrop,
    onDragOver: () => $('#drag-modal').modal('show'),
    onDragLeave: () => $('#drag-modal').modal('hide')
  })
}

if (!window.location.search) {
  ask()
} else {
  let opts = qs.parse(window.location.search.slice(1))
  if (!opts.room) return ask()
  joinRoom(opts.room.slice(0, opts.room.lastIndexOf('/')), opts.room)
}

function getRandom () {
  function toBase64 (buf) {
    buf = new Uint8Array(buf)
    var s = ''
    for (var i = 0; i < buf.byteLength; i++) {
      s += String.fromCharCode(buf[i])
    }
    return btoa(s)
  }
  let key = new Uint8Array(8)
  window.crypto.getRandomValues(key)
  let s = toBase64(key)
  return s.slice(0, s.length - 1)
}
