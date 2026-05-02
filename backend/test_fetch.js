fetch("http://localhost:5000/foods")
  .then(res => res.json())
  .then(data => {
    console.log("FETCH SUCCESS, data length:", data.length);
    console.log(data);
  })
  .catch(err => console.error("FETCH ERROR:", err));
  