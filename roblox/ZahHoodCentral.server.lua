--!strict
--[[
	ZahHoodCentral.server.lua
	------------------------------------------------------------
	Drop this in ServerScriptService. It is the whole game-side
	half of Zah Hood Central:

	  * checks every joining player against the ban list
	  * sends a heartbeat with the live roster and server health
	  * carries out kicks / bans / messages / shutdowns the panel queues
	  * saves playtime and stats back to the player database

	Setup
	  1. Game Settings -> Security -> Allow HTTP Requests: ON
	  2. Create a key in the panel (Game Connection page)
	  3. Fill in CONFIG below
--]]

local CONFIG = {
	BaseUrl = "http://localhost:3000", -- your site, no trailing slash
	ApiKey = "paste-your-key-here",

	HeartbeatSeconds = 15,
	RequestTimeout = 10,
	-- Set false while you are testing so a site outage cannot lock players out.
	KickOnApiFailure = false,
	Verbose = true,
}

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local TextChatService = game:GetService("TextChatService")

local ENDPOINT = CONFIG.BaseUrl .. "/api/game"
local JOB_ID = if game.JobId ~= "" then game.JobId else "studio-" .. HttpService:GenerateGUID(false)

local startedAt = os.clock()
local joinedAt: { [number]: number } = {}
local muted: { [number]: string } = {}

local function log(...)
	if CONFIG.Verbose then
		print("[ZahHood]", ...)
	end
end

local function warnOnce(message: string)
	warn("[ZahHood] " .. message)
end

--------------------------------------------------------------------
-- HTTP
--------------------------------------------------------------------
local function request(method: string, path: string, body: any): (boolean, any)
	local ok, result = pcall(function()
		return HttpService:RequestAsync({
			Url = ENDPOINT .. path,
			Method = method,
			Headers = {
				["Content-Type"] = "application/json",
				["X-ZHC-Key"] = CONFIG.ApiKey,
			},
			Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
		})
	end)

	if not ok then
		return false, tostring(result)
	end
	if not result.Success then
		return false, string.format("HTTP %d: %s", result.StatusCode, result.Body or "")
	end

	local decoded
	local decodeOk = pcall(function()
		decoded = HttpService:JSONDecode(result.Body)
	end)
	if not decodeOk then
		return false, "bad JSON from server"
	end
	return true, decoded
end

--------------------------------------------------------------------
-- Player payloads
--------------------------------------------------------------------
--- Replace the contents of this function with your own leaderstats / DataStore values.
local function statsFor(player: Player): { [string]: any }
	local leaderstats = player:FindFirstChild("leaderstats")
	local function value(name: string, default: number): number
		local obj = leaderstats and leaderstats:FindFirstChild(name)
		return if obj and obj:IsA("ValueBase") then (obj :: any).Value else default
	end

	return {
		cash = value("Cash", 0),
		level = value("Level", 1),
		kills = value("Kills", 0),
		deaths = value("Deaths", 0),
		robberies = value("Robberies", 0),
		arrests = value("Arrests", 0),
		crew = nil,
		playtime = math.floor(os.time() - (joinedAt[player.UserId] or os.time())),
	}
end

local function describe(player: Player): { [string]: any }
	return {
		userId = player.UserId,
		username = player.Name,
		displayName = player.DisplayName,
		accountAge = player.AccountAge,
		team = if player.Team then player.Team.Name else nil,
		device = if player:GetAttribute("Device") then player:GetAttribute("Device") else nil,
		stats = statsFor(player),
	}
end

--------------------------------------------------------------------
-- Actions the panel queues for this server
--------------------------------------------------------------------
local function findPlayer(userId: number?): Player?
	if not userId then
		return nil
	end
	return Players:GetPlayerByUserId(userId)
end

local function announce(message: string, from: string?)
	local text = if from then string.format("[%s] %s", from, message) else message
	-- Swap this for your own notification UI / RemoteEvent if you have one.
	pcall(function()
		local channel = TextChatService:FindFirstChild("TextChannels")
		local system = channel and channel:FindFirstChild("RBXSystem")
		if system then
			(system :: any):DisplaySystemMessage(text)
		end
	end)
	log("ANNOUNCE:", text)
end

local function runAction(action: any)
	local kind = action.type
	local player = findPlayer(action.robloxId)
	local payload = action.payload or {}

	if kind == "kick" then
		if player then
			player:Kick("Kicked by staff.\nReason: " .. (payload.reason or "No reason given"))
		end
	elseif kind == "ban" then
		if player then
			local suffix = if payload.expiresAt
				then "\nThis ban expires later."
				else "\nThis ban is permanent."
			player:Kick("You are banned from Zah Hood.\nReason: "
				.. (payload.reason or "No reason given")
				.. suffix
				.. "\nAppeal at " .. CONFIG.BaseUrl .. "/appeal")
		end
	elseif kind == "unban" then
		-- Nothing to do in-server; the site already lifted it.
		log("unban acknowledged for", action.robloxId)
	elseif kind == "mute" then
		if action.robloxId then
			muted[action.robloxId] = payload.reason or "Muted by staff"
		end
	elseif kind == "unmute" then
		if action.robloxId then
			muted[action.robloxId] = nil
		end
	elseif kind == "message" then
		announce(payload.message or "", payload.from)
	elseif kind == "shutdown" then
		announce("This server is shutting down: " .. (payload.reason or "staff request"))
		task.delay(5, function()
			for _, p in Players:GetPlayers() do
				p:Kick("Server shut down by staff.\n" .. (payload.reason or ""))
			end
		end)
	else
		log("unknown action type:", tostring(kind))
	end
end

local function handleActions(actions: { any }?)
	if not actions or #actions == 0 then
		return
	end
	local ids = {}
	for _, action in actions do
		local ok, err = pcall(runAction, action)
		if not ok then
			warnOnce("action " .. tostring(action.type) .. " failed: " .. tostring(err))
		end
		table.insert(ids, action.id)
	end
	task.spawn(function()
		request("POST", "/ack", { ids = ids })
	end)
end

--------------------------------------------------------------------
-- Join / leave
--------------------------------------------------------------------
local function onPlayerAdded(player: Player)
	joinedAt[player.UserId] = os.time()

	local ok, response = request("POST", "/join", {
		serverId = JOB_ID,
		player = describe(player),
	})

	if not ok then
		warnOnce("join check failed for " .. player.Name .. ": " .. tostring(response))
		if CONFIG.KickOnApiFailure then
			player:Kick("Could not reach Zah Hood Central. Try again in a minute.")
		end
		return
	end

	if response.banned and response.ban then
		player:Kick(response.ban.message or ("You are banned from Zah Hood.\nReason: " .. tostring(response.ban.reason)))
		return
	end

	if response.muted and response.mute then
		muted[player.UserId] = response.mute.reason
	end

	-- `response.profile` carries everything the site knows about them.
	-- Hand it to your own data loader here if you want the site to be
	-- the source of truth for cash / level / inventory.
	player:SetAttribute("ZHC_Loaded", true)
	log(player.Name, "cleared to play. Prior warnings:", response.warnings or 0)
end

local function onPlayerRemoving(player: Player)
	local session = os.time() - (joinedAt[player.UserId] or os.time())
	joinedAt[player.UserId] = nil
	muted[player.UserId] = nil

	task.spawn(function()
		request("POST", "/leave", {
			serverId = JOB_ID,
			player = describe(player),
			sessionSeconds = session,
		})
	end)
end

--------------------------------------------------------------------
-- Heartbeat
--------------------------------------------------------------------
local frameCount = 0
local frameClock = os.clock()
local currentFps = 60

RunService.Heartbeat:Connect(function()
	frameCount += 1
	local elapsed = os.clock() - frameClock
	if elapsed >= 2 then
		currentFps = frameCount / elapsed
		frameCount = 0
		frameClock = os.clock()
	end
end)

local function heartbeat()
	local roster = {}
	for _, player in Players:GetPlayers() do
		table.insert(roster, describe(player))
	end

	local ok, response = request("POST", "/heartbeat", {
		serverId = JOB_ID,
		placeId = tostring(game.PlaceId),
		players = roster,
		playerCount = #roster,
		maxPlayers = Players.MaxPlayers,
		uptime = math.floor(os.clock() - startedAt),
		fps = math.floor(currentFps * 10) / 10,
		ping = 0,
		memory = math.floor(collectgarbage("count") / 1024),
		version = tostring(game.PlaceVersion),
	})

	if not ok then
		warnOnce("heartbeat failed: " .. tostring(response))
		return
	end

	handleActions(response.actions)
end

--------------------------------------------------------------------
-- Public API for the rest of your game
--------------------------------------------------------------------
local ZahHood = {}

--- Report a gameplay event so it shows up in the panel's activity feed.
function ZahHood.logEvent(eventType: string, player: Player?, detail: string?, data: any?)
	task.spawn(function()
		request("POST", "/events", {
			serverId = JOB_ID,
			events = {
				{
					type = eventType,
					userId = if player then player.UserId else nil,
					username = if player then player.Name else nil,
					detail = detail,
					data = data,
				},
			},
		})
	end)
end

--- Punish someone from inside the game (an in-game admin command, an anti-cheat hit, ...).
function ZahHood.punish(userId: number, username: string, kind: string, reason: string, duration: string?, moderator: string?)
	task.spawn(function()
		local ok, response = request("POST", "/punish", {
			serverId = JOB_ID,
			userId = userId,
			username = username,
			type = kind,
			reason = reason,
			duration = duration,
			moderator = moderator,
		})
		if not ok then
			warnOnce("punish failed: " .. tostring(response))
		end
	end)
end

--- True when the panel has this player muted.
function ZahHood.isMuted(userId: number): boolean
	return muted[userId] ~= nil
end

_G.ZahHood = ZahHood

--------------------------------------------------------------------
-- Boot
--------------------------------------------------------------------
if CONFIG.ApiKey == "paste-your-key-here" then
	warnOnce("No API key set - open the Game Connection page in the panel, create a key, and paste it into CONFIG.ApiKey.")
	return
end

do
	local ok, response = request("GET", "/ping", nil)
	if ok then
		log("connected to Zah Hood Central as key:", tostring(response.key))
	else
		warnOnce("could not reach Zah Hood Central: " .. tostring(response))
	end
end

Players.PlayerAdded:Connect(function(player)
	local ok, err = pcall(onPlayerAdded, player)
	if not ok then
		warnOnce("onPlayerAdded failed: " .. tostring(err))
	end
end)

-- Players who beat the connection above.
for _, player in Players:GetPlayers() do
	task.spawn(onPlayerAdded, player)
end

Players.PlayerRemoving:Connect(onPlayerRemoving)

game:BindToClose(function()
	for _, player in Players:GetPlayers() do
		pcall(onPlayerRemoving, player)
	end
	task.wait(1)
end)

task.spawn(function()
	while true do
		local ok, err = pcall(heartbeat)
		if not ok then
			warnOnce("heartbeat error: " .. tostring(err))
		end
		task.wait(CONFIG.HeartbeatSeconds)
	end
end)

log("ZahHoodCentral online. Server id:", JOB_ID)
