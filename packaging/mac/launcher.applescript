-- Piano by Ear, the downloaded Mac app. Click when stopped: start the drill.
-- Click when running: the sound (the keyboard's own, or the computer's
-- pianos, downloaded on first use), where the metronome comes from when the
-- keyboard is the sound, Free play / Drill when the computer is the sound,
-- Restart, Quit. Everything else happens at the piano.
on pbe()
	return quoted form of (POSIX path of (path to me) & "Contents/Resources/pbe.sh")
end pbe

on sh(cmd)
	return do shell script cmd
end sh

on havePianos()
	try
		sh(pbe() & " have-pianos")
		return true
	on error
		return false
	end try
end havePianos

on startAs(mode)
	if mode is "free" then
		sh(pbe() & " start free >/dev/null 2>&1")
		display notification "Free play: nothing is graded or recorded." with title "Piano by Ear"
	else
		sh(pbe() & " start >/dev/null 2>&1")
		display notification "Listening. Play one note to start, or your own chord to keep a history." with title "Piano by Ear"
	end if
end startAs

on downloadPianos()
	display notification "Downloading the pianos (about 75 MB). This takes a minute." with title "Piano by Ear"
	try
		sh(pbe() & " pianos 2>&1")
	on error msg
		display alert "The pianos could not be downloaded" message msg as warning
		return false
	end try
	return true
end downloadPianos

on run
	set stat to sh(pbe() & " status")
	if stat starts with "stopped" then
		startAs("drill")
		return
	end if
	set mode to "drill"
	if stat contains "free" then set mode to "free"
	set computerSound to (sh(pbe() & " sound") is "app")
	set menuItems to {}
	if computerSound then
		if mode is "free" then
			set end of menuItems to "Drill"
		else
			set end of menuItems to "Free play"
		end if
		set end of menuItems to "Use my keyboard's own sound"
		set what to "Running, with the computer's pianos."
	else
		if havePianos() then
			set end of menuItems to "Use the computer's pianos"
		else
			set end of menuItems to "Download pianos (for a keyboard with no sound of its own)"
		end if
		if sh(pbe() & " clicks") is "computer" then
			set end of menuItems to "Metronome from my keyboard"
		else
			set end of menuItems to "Metronome from the computer"
		end if
		set what to "Running, with your keyboard's own sound."
	end if
	set end of menuItems to "Restart"
	set end of menuItems to "Quit Piano by Ear"
	set act to choose from list menuItems with title "Piano by Ear" with prompt what OK button name "OK" cancel button name "Cancel"
	if act is false then return
	set act to item 1 of act
	if act is "Free play" then
		startAs("free")
	else if act is "Drill" or act is "Restart" then
		startAs(mode)
	else if act starts with "Metronome from" then
		sh(pbe() & " clicks toggle")
		startAs(mode)
	else if act is "Use my keyboard's own sound" then
		sh(pbe() & " keyboard")
		startAs("drill")
	else if act is "Use the computer's pianos" or act starts with "Download pianos" then
		if downloadPianos() then startAs("drill")
	else
		sh(pbe() & " stop >/dev/null 2>&1")
		display notification "Stopped." with title "Piano by Ear"
	end if
end run
