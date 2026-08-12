package prompt

import clack "github.com/orochaa/go-clack/prompts"

func Intro(msg string) {
	clack.Intro(msg)
}

func Outro(msg string) {
	clack.Outro(msg)
}

func LogInfo(msg string)   { clack.Info(msg) }
func LogSuccess(msg string) { clack.Success(msg) }
func LogStep(msg string)    { clack.Step(msg) }
func LogWarn(msg string)    { clack.Warn(msg) }
func LogError(msg string)   { clack.Error(msg) }

func LogNote(title, body string) {
	clack.Note(body, clack.NoteOptions{Title: title})
}
