import os
from flask import Flask, render_template

app = Flask(__name__)

@app.route('/')
def index():
    # Wir geben eine Variable mit, um zu sehen, dass Jinja2 funktioniert
    return render_template('index.html', message="Die Pipeline funktioniert!")

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)