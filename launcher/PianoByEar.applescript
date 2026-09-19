-- Piano by Ear launcher. Click when stopped: offer to disable lid sleep
-- (admin dialog; Cancel leaves it alone), then start the drill. Click when
-- running: Free play or Drill (switch mode), the sound toggle (app pianos
-- <-> the keyboard's own sound engine, which restarts in place), Restart,
-- End drill. Only launch and End drill touch the sleep setting.
-- THERE IS NO "SWITCH USER". Since 2026-09-19 the player names himself from
-- the keyboard: his chord opens his profile. This menu only reports who is
-- loaded.
-- It always boots into the drill; free play is only reached from the menu.
-- @@PBE@@ is replaced with the path to launcher/pbe.sh by build.sh.
property pbe : "@@PBE@@"
property flagFile : "~/.piano-by-ear/lid-sleep-disabled"

on sh(cmd)
	return do shell script cmd
end sh

on statusLine()
	return sh(quoted form of pbe & " status")
end statusLine

on currentUser()
	return sh(quoted form of pbe & " current")
end currentUser

on currentMode()
	return sh(quoted form of pbe & " mode")
end currentMode

on currentSound()
	return sh(quoted form of pbe & " sound")
end currentSound

-- Hand the sound to the instrument, or take it back. Read at startup, so the
-- running process is restarted in place to pick it up.
on toggleSound(mode)
	if currentSound() is "hardware" then
		sh(quoted form of pbe & " sound app")
		display notification "The app's pianos again." with title "Piano by Ear"
	else
		sh(quoted form of pbe & " sound hardware")
		display notification "Your keyboard's own sound. Only the clicks come from the app." with title "Piano by Ear"
	end if
	startAs(mode)
end toggleSound

on startAs(mode)
	if mode is "free" then
		sh(quoted form of pbe & " start free >/dev/null 2>&1")
		display notification "Free play: nothing is graded or recorded." with title "Piano by Ear"
	else
		sh(quoted form of pbe & " start >/dev/null 2>&1")
		display notification "Running. Play your chord to open your profile." with title "Piano by Ear"
	end if
end startAs

on disableSleep()
	try
		do shell script "pmset -a disablesleep 1 && touch " & flagFile with administrator privileges with prompt "Piano by Ear: keep running with the lid closed?" & return & return & "Enter your password to disable sleep until you end the drill. Cancel leaves sleep as it is."
	on error
		-- cancelled: leave the setting untouched
	end try
end disableSleep

on restoreSleep()
	try
		sh("test -f " & flagFile)
	on error
		return -- was never disabled by us
	end try
	try
		do shell script "pmset -a disablesleep 0 && rm -f " & flagFile with administrator privileges with prompt "Piano by Ear stopped: enter your password to re-enable sleep."
	on error
		display alert "Sleep is still disabled" message "The dialog was cancelled. To re-enable sleep later, run in Terminal:" & return & return & "sudo pmset -a disablesleep 0" as warning
	end try
end restoreSleep

on run
	set stat to statusLine()
	if stat starts with "stopped" then
		disableSleep()
		startAs("drill")
	else
		set user to currentUser()
		set mode to currentMode()
		if currentSound() is "hardware" then
			set soundItem to "Use the app's pianos"
			set soundNow to "Keyboard's own sound."
		else
			set soundItem to "Use the keyboard's own sound"
			set soundNow to "App pianos."
		end if
		if mode is "free" then
			set menuItems to {"Drill", soundItem, "Restart", "End drill"}
			set what to "Free play. " & soundNow
		else
			set menuItems to {"Free play", soundItem, "Restart", "End drill"}
			if user is "nobody" then
				set what to "Drill running, waiting for a chord. " & soundNow
			else
				set what to "Drill running, " & user & " is playing. " & soundNow
			end if
		end if
		set act to choose from list menuItems with title "Piano by Ear" with prompt what OK button name "OK" cancel button name "Cancel"
		if act is false then return
		set act to item 1 of act
		if act is "Free play" then
			startAs("free")
		else if act is "Drill" then
			startAs("drill")
		else if act is soundItem then
			toggleSound(mode)
		else if act is "Restart" then
			startAs(mode)
		else if act is "End drill" then
			sh(quoted form of pbe & " stop >/dev/null 2>&1")
			restoreSleep()
			display notification "Drill ended." with title "Piano by Ear"
		end if
	end if
end run
