const {EditorState, Plugin} = require("prosemirror-state")
const {MenuBarEditorView} = require("prosemirror-menu")
const {Mapping} = require("prosemirror-transform")
const {schema} = require("prosemirror-schema-basic")
const {exampleSetup} = require("prosemirror-example-setup")
const crel = require("crel")

const trackPlugin = new Plugin({
  stateFields: {
    trackedChanges: {
      init(_, instance) {
        return new TrackState([new Span(0, instance.doc.content.size, null)], [], [], [])
      },
      applyAction(state, action) {
        if (action.type == "transform")
          return state.trackedChanges.applyTransform(action.transform)
        if (action.type == "commit")
          return state.trackedChanges.applyCommit(action.message, action.time)
        else
          return state.trackedChanges
      }
    }
  }
})

class Span {
  constructor(from, to, commit) {
    this.from = from; this.to = to; this.commit = commit
  }
}

class Commit {
  constructor(message, time, steps, maps, hidden) {
    this.message = message
    this.time = time
    this.steps = steps
    this.maps = maps
    this.hidden = hidden
  }
}

class TrackState {
  constructor(blameMap, commits, uncommittedSteps, uncommittedMaps) {
    this.blameMap = blameMap
    this.commits = commits
    this.uncommittedSteps = uncommittedSteps
    this.uncommittedMaps = uncommittedMaps
  }

  applyTransform(transform) {
    let inverted = transform.steps.map((step, i) => step.invert(transform.docs[i]))
    return new TrackState(updateBlameMap(this.blameMap, transform, this.commits.length),
                          this.commits,
                          this.uncommittedSteps.concat(inverted),
                          this.uncommittedMaps.concat(transform.mapping.maps))
  }

  applyCommit(message, time) {
    if (this.uncommittedSteps.length == 0) return this
    let commit = new Commit(message, time, this.uncommittedSteps, this.uncommittedMaps)
    return new TrackState(this.blameMap, this.commits.concat(commit), [], [])
  }
}

function updateBlameMap(map, transform, id) {
  let result = [], mapping = transform.mapping
  for (let i = 0; i < map.length; i++) {
    let span = map[i]
    let from = mapping.map(span.from, 1), to = mapping.map(span.to, -1)
    if (from < to) result.push(new Span(from, to, span.commit))
  }

  for (let i = 0; i < mapping.maps.length; i++) {
    let map = mapping.maps[i], after = mapping.slice(i + 1)
    map.forEach((_s, _e, start, end) => {
      insertIntoBlameMap(result, after.map(start, 1), after.map(end, -1), id)
    })
  }

  return result
}

function insertIntoBlameMap(map, from, to, commit) {
  let pos = 0, next
  for (; pos < map.length; pos++) {
    next = map[pos]
    if (next.commit == commit) {
      if (next.to >= from) break
    } else if (next.to > from) { // Different commit, not before
      if (next.from < from) { // Sticks out to the left (loop below will handle right side)
        let left = new Span(next.from, from, next.commit)
        if (next.to > to) map.splice(pos++, 0, left)
        else map[pos++] = left
      }
      break
    }
  }

  while (next = map[pos]) {
    if (next.commit == commit) {
      if (next.from > to) break
      from = Math.min(from, next.from)
      to = Math.max(to, next.to)
      map.splice(pos, 1)
    } else {
      if (next.from >= to) break
      if (next.to > to) {
        map[pos] = new Span(to, next.to, next.commit)
        break
      } else {
        map.splice(pos, 1)
      }
    }
  }

  map.splice(pos, 0, new Span(from, to, commit))
}

let state = EditorState.create({
  schema,
  plugins: [exampleSetup({schema}), trackPlugin]
}), view

function onAction(action) {
  state = state.applyAction(action)
  view.updateState(state)
  setDisabled(state)
  renderCommits(state)
}

view = new MenuBarEditorView(document.querySelector("#editor"), {state, onAction})

function commitAction(message) {
  return {type: "commit", message, time: new Date}
}

onAction(state.tr.insertText("Type something, and then commit it.").action())
onAction(commitAction("Initial commit"))

function setDisabled(state) {
  let input = document.querySelector("#message")
  let button = document.querySelector("#commitbutton")
  input.disabled = button.disabled = state.trackedChanges.uncommittedSteps.length == 0
}

function doCommit(message) {
  onAction(commitAction(message))
}

let lastRendered = null
function renderCommits(state) {
  if (lastRendered == state.trackedChanges) return
  lastRendered = state.trackedChanges

  let out = document.querySelector("#commits")
  out.textContent = ""
  let commits = state.trackedChanges.commits
  commits.forEach(commit => {
    let node = crel("div", {class: "commit"},
                    crel("span", {class: "commit-time"},
                         commit.time.getHours() + ":" + (commit.time.getMinutes() < 10 ? "0" : "")
                         + commit.time.getMinutes()),
                    "\u00a0 " + commit.message + "\u00a0 ",
                    crel("button", {class: "commit-revert"}, "revert"))
    node.lastChild.addEventListener("click", () => revertCommit(commit))
    node.addEventListener("mouseover", e => {
      if (!node.contains(e.relatedTarget)) highlightCommit(commit)
    })
    node.addEventListener("mouseout", e => {
      if (!node.contains(e.relatedTarget)) clearHighlight(commit)
    })
    out.appendChild(node)
  })
}

let highlighted = null

function annotateRange({from, to}) {
  let left = document.body.appendChild(crel("span", {class: "marker-left"}))
  let right = document.body.appendChild(crel("span", {class: "marker-right"}))
  let leftPos = view.editor.coordsAtPos(from), rightPos = view.editor.coordsAtPos(to)
  left.style.left = leftPos.left + "px"
  left.style.top = (leftPos.bottom - 3) + "px"
  right.style.right = (document.body.clientWidth - rightPos.right) + "px"
  right.style.top = (rightPos.bottom - 3) + "px"
  return {left, right}
}
function clearRange({left, right}) {
  document.body.removeChild(left)
  document.body.removeChild(right)
}

function highlightCommit(commit) {
  if (highlighted && highlighted.commit == commit) return
  let tState = state.trackedChanges
  if (highlighted) clearHighlight(highlighted.commit)
  highlighted = {
    ranges: tState.blameMap.filter(span => tState.commits[span.commit] == commit).map(annotateRange),
    commit: commit
  }
}
function clearHighlight(commit) {
  if (highlighted && highlighted.commit == commit) {
    highlighted.ranges.forEach(clearRange)
    highlighted = null
  }
}

function revertCommit(commit) {
  let tState = state.trackedChanges
  let found = tState.commits.indexOf(commit)
  if (found == -1) return

  if (tState.uncommittedSteps.length) return alert("Commit your changes first!")

  let remap = new Mapping(tState.commits.slice(found).reduce((maps, c) => maps.concat(c.maps), []))
  let tr = state.tr
  for (let i = commit.steps.length - 1; i >= 0; i--) {
    let remapped = commit.steps[i].map(remap.slice(i + 1))
    let result = remapped && tr.maybeStep(remapped)
    if (result && result.doc) remap.appendMap(remapped.getMap(), i)
  }
  if (tr.steps.length) {
    onAction(tr.action())
    onAction(commitAction(`Revert '${commit.message}'`))
  }
}

document.querySelector("#commit").addEventListener("submit", e => {
  e.preventDefault()
  doCommit(e.target.elements.message.value || "Unnamed")
  e.target.elements.message.value = ""
  view.editor.focus()
})

function findInBlameMap(pos, state) {
  let map = state.trackedChanges.blameMap
  for (let i = 0; i < map.length; i++)
    if (map[i].to >= pos && map[i].commit != null)
      return map[i].commit
}

document.querySelector("#blame").addEventListener("mousedown", e => {
  e.preventDefault()
  let pos = e.target.getBoundingClientRect()
  let commitID = findInBlameMap(state.selection.head, state)
  let commit = commitID != null && state.trackedChanges.commits[commitID]
  let node = crel("div", {class: "blame-info"},
                  commitID != null ? ["It was: ", crel("strong", null, commit ? commit.message : "Uncommitted")]
                  : "No commit found")
  node.style.right = (document.body.clientWidth - pos.right) + "px"
  node.style.top = (pos.bottom + 2) + "px"
  document.body.appendChild(node)
  setTimeout(() => document.body.removeChild(node), 2000)
})
